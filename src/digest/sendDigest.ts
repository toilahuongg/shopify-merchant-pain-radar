/**
 * Digest + realtime alert delivery.
 *
 * Ranking, rendering and Telegram access are all injected: this module only
 * orchestrates `rankClustersFromDb` -> optional one-shot AI enrichment ->
 * `buildDigest` -> `TelegramClient.sendMessage`.
 */

import { getLastAlertAt, recordAlert } from "../lib/db";
import { escapeHtml } from "../lib/telegram";
import { rankClustersFromDb } from "../processing/ranking";
import {
  DIGEST_SYSTEM_PROMPT,
  buildClusterSummaryPrompt,
  parseClusterSummaryResponse,
} from "../prompts/digest";
import { buildDigest } from "./buildDigest";
import type { AiClient } from "../lib/ai";
import type { AppConfig } from "../lib/config";
import type { Logger } from "../lib/logger";
import type { TelegramClient } from "../lib/telegram";
import type { RankedCluster } from "../types";

export interface DigestDeps {
  db: D1Database;
  telegram: TelegramClient;
  logger: Logger;
  config: AppConfig;
  ai?: AiClient;
  now?: number;
}

export interface DigestSendResult {
  ok: boolean;
  clusters: number;
  messages: number;
  error?: string;
}

/** Local enrichment shape; the shared RankedCluster type is not modified. */
type EnrichedCluster = RankedCluster & {
  title?: string;
  potentialProduct?: string;
  problemShort?: string;
};

const DIGEST_WINDOW_DAYS = 7;
const DIGEST_CLUSTER_LIMIT = 100;
const ALERT_WINDOW_DAYS = 7;
const ALERT_CLUSTER_LIMIT = 50;
const ALERT_EXAMPLES = 2;
const MAX_ALERTS_PER_RUN = 5;
const HOUR_MS = 3_600_000;
const MAX_TEXT = 160;
const MAX_URL = 80;

function clip(text: string, max = MAX_TEXT): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function buyingIntentLabel(value: number): "CAO" | "TRUNG BÌNH" | "THẤP" {
  if (!Number.isFinite(value)) return "THẤP";
  if (value >= 4) return "CAO";
  if (value >= 3) return "TRUNG BÌNH";
  return "THẤP";
}

function sourceLine(cluster: RankedCluster): string {
  const entries = Object.entries(cluster.sources ?? {}).sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return "không rõ";
  return entries.map(([source, count]) => `${escapeHtml(source)} ${count}`).join(" · ");
}

function renderAlert(cluster: RankedCluster): string {
  const problem = clip(cluster.summary.trim()) || cluster.problemKey.replace(/[-_]+/g, " ");
  const lines = [
    "🚨 NỖI ĐAU MERCHANT TÍN HIỆU CAO",
    `Vấn đề: ${escapeHtml(problem)}`,
    `Điểm cơ hội: ${Math.round(cluster.score)}/100`,
    `Nhu cầu mua: ${buyingIntentLabel(cluster.buyingIntent)}`,
    `Số đề cập tương tự tuần này: ${cluster.mentions7d}`,
    `Nguồn: ${sourceLine(cluster)}`,
  ];

  const links = cluster.examplePosts
    .slice(0, 2)
    .map((post) => escapeHtml(clip(post.url, MAX_URL)))
    .filter((url) => url !== "");
  if (links.length > 0) lines.push(`Liên kết: ${links.join(" · ")}`);

  return lines.join("\n");
}

/**
 * ONE batched AI call for the top clusters. Any failure (or unparseable
 * output) is logged and the original clusters are returned so the digest can
 * still be sent with deterministic fallback text.
 */
async function enrichTopClusters(
  deps: DigestDeps,
  clusters: readonly RankedCluster[],
): Promise<readonly EnrichedCluster[]> {
  const ai = deps.ai;
  const topN = Number.isFinite(deps.config.digest.topN)
    ? Math.max(0, Math.floor(deps.config.digest.topN))
    : 0;
  const top = clusters.slice(0, topN);
  if (!ai || top.length === 0) return clusters;

  try {
    const user = buildClusterSummaryPrompt(
      top.map((cluster) => ({
        problemKey: cluster.problemKey,
        category: cluster.category,
        problem: cluster.summary,
        currentWorkaround: null,
        desiredOutcome: null,
        mentions: cluster.mentions,
        buyingIntent: cluster.buyingIntent,
      })),
    );
    const raw = await ai.complete({ system: DIGEST_SYSTEM_PROMPT, user, json: true });
    const summaries = parseClusterSummaryResponse(raw);
    if (summaries.size === 0) {
      deps.logger.warn("digest.ai_unparsed", { requested: top.length });
      return clusters;
    }

    return clusters.map((cluster) => {
      const summary = summaries.get(cluster.problemKey);
      if (!summary) return cluster;
      const enriched: EnrichedCluster = { ...cluster };
      if (summary.title !== "") enriched.title = summary.title;
      if (summary.potentialProduct !== "") enriched.potentialProduct = summary.potentialProduct;
      if (summary.problemShort !== "") enriched.problemShort = summary.problemShort;
      return enriched;
    });
  } catch (error) {
    deps.logger.warn("digest.ai_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return clusters;
  }
}

export async function sendDailyDigest(deps: DigestDeps): Promise<DigestSendResult> {
  const now = deps.now ?? Date.now();
  const { db, telegram, logger, config } = deps;

  const clusters = await rankClustersFromDb(db, {
    now,
    windowDays: DIGEST_WINDOW_DAYS,
    limit: DIGEST_CLUSTER_LIMIT,
    minScore: config.limits.minDigestOpportunityScore,
    examplesPerCluster: 2,
  });

  if (clusters.length === 0) {
    logger.info("digest.empty", { windowDays: DIGEST_WINDOW_DAYS });
    return { ok: true, clusters: 0, messages: 0 };
  }

  const enriched = await enrichTopClusters(deps, clusters);
  const content = buildDigest(enriched, {
    topN: config.digest.topN,
    emergingN: config.digest.emergingN,
    buyingIntentN: config.digest.buyingIntentN,
  });

  logger.info("digest.built", {
    clusters: content.totalClusters,
    top: content.topCount,
    emerging: content.emergingCount,
    buyingIntent: content.buyingIntentCount,
  });

  const result = await telegram.sendMessage(content.html);
  if (!result.ok) {
    const error = result.error ?? "telegram_send_failed";
    logger.error("digest.send_failed", {
      clusters: content.totalClusters,
      messages: result.messages,
      error,
    });
    return { ok: false, clusters: content.totalClusters, messages: result.messages, error };
  }

  logger.info("digest.sent", { clusters: content.totalClusters, messages: result.messages });
  return { ok: true, clusters: content.totalClusters, messages: result.messages };
}

export async function sendRealtimeAlerts(deps: DigestDeps): Promise<{ alerted: number }> {
  const now = deps.now ?? Date.now();
  const { db, telegram, logger, config } = deps;
  const cooldownMs = Math.max(0, config.alerts.cooldownHours) * HOUR_MS;

  const clusters = await rankClustersFromDb(db, {
    now,
    windowDays: ALERT_WINDOW_DAYS,
    limit: ALERT_CLUSTER_LIMIT,
    minScore: config.alerts.threshold,
    examplesPerCluster: ALERT_EXAMPLES,
  });

  let alerted = 0;
  for (const cluster of clusters) {
    if (alerted >= MAX_ALERTS_PER_RUN) break;
    if (cluster.score < config.alerts.threshold) continue;

    const lastAlertAt = await getLastAlertAt(db, cluster.problemKey);
    if (lastAlertAt !== null && now - lastAlertAt < cooldownMs) continue;

    const result = await telegram.sendMessage(renderAlert(cluster));
    if (!result.ok) {
      logger.error("alert.send_failed", {
        problemKey: cluster.problemKey,
        error: result.error ?? "telegram_send_failed",
      });
      continue;
    }

    await recordAlert(db, cluster.problemKey, now, cluster.score);
    alerted += 1;
    logger.info("alert.sent", {
      problemKey: cluster.problemKey,
      score: cluster.score,
      mentions7d: cluster.mentions7d,
      messages: result.messages,
    });
  }

  return { alerted };
}
