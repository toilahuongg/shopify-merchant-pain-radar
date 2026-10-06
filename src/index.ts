/**
 * MerchantSignal worker entrypoint.
 *
 * scheduled(): three cron triggers, mapped by cron expression
 * queue():     candidate posts -> batched AI classification -> D1
 * fetch():     health, stats, opportunities + authenticated admin triggers
 */

import { createAiClient } from "./lib/ai";
import { loadConfig } from "./lib/config";
import { aggregateClusters } from "./processing/cluster";
import { listClusters, getStatsCounts } from "./lib/db";
import { createLogger } from "./lib/logger";
import { rankClustersFromDb } from "./processing/ranking";
import { sendDailyDigest } from "./digest/sendDigest";
import { createTelegramClient } from "./lib/telegram";
import { processQueueBatch } from "./pipeline/processBatch";
import { runIngest } from "./pipeline/ingest";
import type { Env } from "./env";
import type { PainQueueMessage, RankedCluster } from "./types";

export type CronTask = "collect" | "aggregate" | "digest";

/** Cron expression -> task. Must stay in sync with wrangler.jsonc triggers. */
const CRON_TASKS: Record<string, CronTask> = {
  "0 */2 * * *": "collect",
  "20 */2 * * *": "aggregate",
  "0 1 * * *": "digest",
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

/** Public API shape for a ranked cluster (snake_case, as documented). */
function serializeCluster(cluster: RankedCluster): Record<string, unknown> {
  return {
    problem_key: cluster.problemKey,
    category: cluster.category,
    summary: cluster.summary,
    score: cluster.score,
    mentions: cluster.mentions,
    mentions_24h: cluster.mentions24h,
    mentions_7d: cluster.mentions7d,
    mentions_prev_7d: cluster.mentionsPrev7d,
    growth: cluster.growth,
    avg_score: cluster.avgScore,
    max_score: cluster.maxScore,
    buying_intent: cluster.buyingIntent,
    manual_work: cluster.manualWork,
    severity: cluster.severity,
    sources: cluster.sources,
    source_count: cluster.sourceCount,
    discussion_count: cluster.discussionCount,
    first_seen: cluster.firstSeen,
    last_seen: cluster.lastSeen,
    example_posts: cluster.examplePosts.map((example) => ({
      post_id: example.postId,
      url: example.url,
      source: example.source,
      title: example.title,
      snippet: example.snippet,
    })),
  };
}

/** Constant-time comparison for the admin bearer token. */
function safeEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function isAdminRequest(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const config = loadConfig(env);
  return safeEqual(match[1].trim(), config.adminApiKey);
}

async function runCronTask(env: Env, task: CronTask): Promise<void> {
  const logger = createLogger(`cron.${task}`);
  const now = Date.now();
  const config = loadConfig(env);

  if (task === "collect") {
    await runIngest(env, logger, now);
    return;
  }

  if (task === "aggregate") {
    const result = await aggregateClusters(env.DB, now);
    logger.info("aggregate.summary", { ...result });
    return;
  }

  const telegram = createTelegramClient({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    logger: logger.child("telegram"),
  });
  const ai = createAiClient({ ...config.ai, logger: logger.child("ai") });
  const result = await sendDailyDigest({ db: env.DB, telegram, logger, config, ai, now });
  logger.info("digest.summary", { ...result });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const logger = createLogger("http");
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const now = Date.now();

    try {
      if (request.method === "GET" && path === "/health") {
        return jsonResponse({ ok: true, ts: now });
      }

      if (request.method === "GET" && path === "/stats") {
        const config = loadConfig(env);
        const stats = await getStatsCounts(env.DB, now, config.limits.minStoreOpportunityScore);
        return jsonResponse({
          posts_24h: stats.posts24h,
          ai_candidates_24h: stats.aiCandidates24h,
          pain_signals_24h: stats.painSignals24h,
          clusters_total: stats.clustersTotal,
          high_opportunities_7d: stats.highOpportunities7d,
          sources: stats.sources,
          posts_7d: stats.posts7d,
          pain_signals_7d: stats.painSignals7d,
        });
      }

      if (request.method === "GET" && path === "/opportunities") {
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
        const clusters = await rankClustersFromDb(env.DB, {
          now,
          windowDays: days,
          limit,
          minScore: 0,
          examplesPerCluster: 3,
        });
        return jsonResponse({
          days,
          limit,
          count: clusters.length,
          clusters: clusters.map(serializeCluster),
        });
      }

      const opportunityMatch = /^\/opportunities\/([a-z0-9-]+)$/.exec(path);
      if (request.method === "GET" && opportunityMatch?.[1]) {
        const problemKey = opportunityMatch[1];
        const clusters = await rankClustersFromDb(env.DB, {
          now,
          windowDays: 30,
          limit: 500,
          minScore: 0,
          examplesPerCluster: 5,
        });
        const cluster = clusters.find((entry) => entry.problemKey === problemKey);
        if (cluster) return jsonResponse(serializeCluster(cluster));

        const known = await listClusters(env.DB, 500);
        const fallback = known.find((row) => row.problem_key === problemKey);
        if (!fallback) return jsonResponse({ error: "not_found", problem_key: problemKey }, 404);
        return jsonResponse({ ...fallback, stale: true });
      }

      if (request.method === "POST" && path.startsWith("/admin/")) {
        if (!isAdminRequest(request, env)) {
          return jsonResponse({ error: "unauthorized" }, 401);
        }
        const adminLogger = createLogger("admin");

        if (path === "/admin/run/collect") {
          const stats = await runIngest(env, adminLogger, now);
          return jsonResponse({ ok: true, ...stats });
        }

        if (path === "/admin/run/digest") {
          const config = loadConfig(env);
          const telegram = createTelegramClient({
            botToken: config.telegram.botToken,
            chatId: config.telegram.chatId,
            logger: adminLogger.child("telegram"),
          });
          const result = await sendDailyDigest({
            db: env.DB,
            telegram,
            logger: adminLogger,
            config,
            now,
          });
          return jsonResponse(result, result.ok ? 200 : 502);
        }

        return jsonResponse({ error: "not_found" }, 404);
      }

      return jsonResponse({ error: "not_found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("http.failed", { path, method: request.method, error: message });
      return jsonResponse({ error: "internal_error", message }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const logger = createLogger("scheduled");
    const task = CRON_TASKS[controller.cron];
    if (!task) {
      logger.warn("scheduled.unknown_cron", { cron: controller.cron });
      return;
    }
    logger.info("scheduled.start", { cron: controller.cron, task });
    ctx.waitUntil(
      runCronTask(env, task).catch((error) => {
        logger.error("scheduled.failed", {
          task,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  },

  async queue(batch: MessageBatch<PainQueueMessage>, env: Env): Promise<void> {
    const logger = createLogger("queue");
    try {
      await processQueueBatch(batch, env, Date.now(), { logger });
      for (const message of batch.messages) message.ack();
    } catch (error) {
      logger.error("queue.batch_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Retry the whole batch: the handler is idempotent (posts are only
      // classified once, signals are INSERT OR IGNORE).
      for (const message of batch.messages) message.retry();
    }
  },
};
