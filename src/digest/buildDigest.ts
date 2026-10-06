/**
 * Pure Telegram digest renderer.
 *
 * `buildDigest` performs no I/O and never mutates its input: it sorts a copy,
 * truncates every dynamic line and escapes all dynamic text as HTML, so the
 * result is safe for `parse_mode: HTML` and stays well below message limits.
 */

import { escapeHtml } from "../lib/telegram";
import type { RankedCluster } from "../types";

export interface DigestOptions {
  topN: number;
  emergingN: number;
  buyingIntentN: number;
}

export interface DigestContent {
  html: string;
  topCount: number;
  emergingCount: number;
  buyingIntentCount: number;
  totalClusters: number;
}

/**
 * Ranked cluster optionally enriched by the digest AI pass
 * (`RankedCluster & { potentialProduct?: string; problemShort?: string }`).
 * `currentWorkaround` / `desiredOutcome` are optional because RankedCluster
 * carries neither; the renderer simply omits or falls back when absent.
 */
type DigestCluster = RankedCluster & {
  title?: string;
  potentialProduct?: string;
  problemShort?: string;
  currentWorkaround?: string;
  desiredOutcome?: string;
};

const SEPARATOR = "──────────────";
const NEW_GROWTH_LABEL = "mới";
/** Longest dynamic text fragment rendered on one line. */
const MAX_TEXT = 160;
/** Longest raw URL rendered in a `Links:` line. */
const MAX_URL = 80;

function sectionCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function humanizeProblemKey(problemKey: string): string {
  return problemKey.replace(/[-_]+/g, " ").trim();
}

/** Collapses whitespace and truncates with an ellipsis. */
function clip(text: string, max = MAX_TEXT): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function buyingIntentLabel(value: number): "CAO" | "TRUNG BÌNH" | "THẤP" {
  if (!Number.isFinite(value)) return "THẤP";
  if (value >= 4) return "CAO";
  if (value >= 3) return "TRUNG BÌNH";
  return "THẤP";
}

/**
 * Formats a growth ratio (e.g. 0.54 -> "+54%"). Non-finite growth means the
 * cluster's growth was not computable and is reported as "new".
 */
export function formatGrowth(growth: number): string {
  if (!Number.isFinite(growth)) return NEW_GROWTH_LABEL;
  const percent = Math.round(growth * 100);
  if (percent === 0) return "0%";
  return percent > 0 ? `+${percent}%` : `${percent}%`;
}

/**
 * Growth label for a cluster. A cluster with no prior-window mentions is
 * reported as "new" (its clamped ratio cannot be told apart from real growth).
 */
function growthLabel(cluster: RankedCluster): string {
  return cluster.mentionsPrev7d === 0 && cluster.mentions7d > 0
    ? NEW_GROWTH_LABEL
    : formatGrowth(cluster.growth);
}

function compareByScore(a: RankedCluster, b: RankedCluster): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.mentions !== a.mentions) return b.mentions - a.mentions;
  return a.problemKey.localeCompare(b.problemKey);
}

function compareByGrowth(a: RankedCluster, b: RankedCluster): number {
  if (b.growth !== a.growth) return b.growth - a.growth;
  if (b.score !== a.score) return b.score - a.score;
  return a.problemKey.localeCompare(b.problemKey);
}

function compareByBuyingIntent(a: RankedCluster, b: RankedCluster): number {
  if (b.buyingIntent !== a.buyingIntent) return b.buyingIntent - a.buyingIntent;
  if (b.score !== a.score) return b.score - a.score;
  return a.problemKey.localeCompare(b.problemKey);
}

/** Display name: the AI-provided Vietnamese title when present, else the key slug. */
function clusterName(cluster: DigestCluster): string {
  const title = trimmed(cluster.title);
  return escapeHtml(clip(title !== "" ? title : humanizeProblemKey(cluster.problemKey), 80));
}

function problemText(cluster: DigestCluster): string {
  const short = trimmed(cluster.problemShort);
  const summary = trimmed(cluster.summary);
  return clip(short !== "" ? short : summary);
}

/** Deterministic product idea used when the AI pass produced no text. */
function fallbackPotentialProduct(cluster: DigestCluster): string {
  const title = trimmed(cluster.title);
  const label = title !== "" ? title : humanizeProblemKey(cluster.problemKey);
  const goal = clip(trimmed(cluster.desiredOutcome), 60);
  return goal !== "" ? `Phần mềm cho ${label} (mục tiêu: ${goal})` : `Phần mềm cho ${label}`;
}

function sourceCounts(cluster: DigestCluster): string {
  const entries = Object.entries(cluster.sources ?? {}).sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return "không rõ";
  return entries.map(([source, count]) => `${escapeHtml(source)} ${count}`).join(" · ");
}

function linkLine(cluster: DigestCluster): string {
  const urls = cluster.examplePosts
    .slice(0, 2)
    .map((post) => escapeHtml(clip(trimmed(post.url), MAX_URL)))
    .filter((url) => url !== "");
  return urls.length === 0 ? "" : `Liên kết: ${urls.join(" · ")}`;
}

function renderTopEntry(cluster: DigestCluster, index: number): string {
  const lines = [
    `${index}. ${clusterName(cluster)} — Điểm: ${Math.round(cluster.score)}/100`,
    `Số đề cập: ${cluster.mentions} · Tăng trưởng 7 ngày: ${growthLabel(cluster)}`,
    `Vấn đề: ${escapeHtml(problemText(cluster))}`,
  ];

  const workaround = clip(trimmed(cluster.currentWorkaround));
  if (workaround !== "") lines.push(`Cách xử lý hiện tại: ${escapeHtml(workaround)}`);

  lines.push(`Nhu cầu mua: ${buyingIntentLabel(cluster.buyingIntent)}`);
  lines.push(`Nguồn: ${sourceCounts(cluster)}`);

  const product = clip(trimmed(cluster.potentialProduct)) || fallbackPotentialProduct(cluster);
  lines.push(`Sản phẩm tiềm năng: ${escapeHtml(product)}`);

  const links = linkLine(cluster);
  if (links !== "") lines.push(links);

  return lines.join("\n");
}

/**
 * Renders the daily digest. Pure: the input array is copied before sorting and
 * never mutated. Emits at most topN + emergingN + buyingIntentN list entries.
 */
export function buildDigest(
  clusters: readonly DigestCluster[],
  options: DigestOptions,
): DigestContent {
  const topN = sectionCount(options.topN);
  const emergingN = sectionCount(options.emergingN);
  const buyingIntentN = sectionCount(options.buyingIntentN);

  const ranked = [...clusters].sort(compareByScore);
  const top = ranked.slice(0, topN);

  const emerging = [...ranked]
    .filter((cluster) => cluster.growth > 0)
    .sort(compareByGrowth)
    .slice(0, emergingN);

  const buying = [...ranked].sort(compareByBuyingIntent).slice(0, buyingIntentN);

  const blocks: string[] = ["🛒 MERCHANT SIGNAL\nRadar nỗi đau merchant hằng ngày"];

  const topBlock = ["🔥 CƠ HỘI HÀNG ĐẦU"];
  if (top.length === 0) {
    topBlock.push("Tuần này chưa có cơ hội nào đạt ngưỡng báo cáo.");
  } else {
    topBlock.push(top.map((cluster, index) => renderTopEntry(cluster, index + 1)).join(`\n${SEPARATOR}\n`));
  }
  blocks.push(topBlock.join("\n"));

  const emergingBlock = ["🚀 NỖI ĐAU ĐANG NỔI LÊN"];
  emergingBlock.push(
    emerging.length === 0
      ? "Tuần này chưa có nỗi đau mới nổi."
      : emerging.map((cluster) => `• ${clusterName(cluster)}: ${growthLabel(cluster)}`).join("\n"),
  );
  blocks.push(emergingBlock.join("\n"));

  const buyingBlock = ["💰 NHU CẦU MUA CAO NHẤT"];
  buyingBlock.push(
    buying.length === 0
      ? "Tuần này chưa có tín hiệu nhu cầu mua."
      : buying
          .map((cluster) => `• ${clusterName(cluster)}: ${buyingIntentLabel(cluster.buyingIntent)}`)
          .join("\n"),
  );
  blocks.push(buyingBlock.join("\n"));

  return {
    html: blocks.join("\n\n"),
    topCount: top.length,
    emergingCount: emerging.length,
    buyingIntentCount: buying.length,
    totalClusters: clusters.length,
  };
}
