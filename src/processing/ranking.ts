/**
 * Opportunity ranking.
 *
 * The score is a deterministic, explainable formula over the aggregated cluster
 * stats — no AI call, no randomness — so the same window always produces the
 * same ordering. All window data is loaded with a fixed number of set-based
 * queries (never one query per cluster).
 */

import {
  getClusterSourceCounts,
  getClusterStatsRows,
  getMentionCounts,
  getSampleSignals,
} from "../lib/db";
import type { ClusterStatsRow, ExamplePost, RankedCluster } from "../types";

export interface TrendInput {
  mentions: number;
  mentions7d: number;
  mentionsPrev7d: number;
  /** Trailing 24h mentions; when omitted the 7d daily pace is assumed. */
  mentions24h?: number;
  sourceCount: number;
  discussionCount: number;
}

export interface RankOptions {
  now: number;
  windowDays?: number;
  limit?: number;
  minScore?: number;
  examplesPerCluster?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 50;
const DEFAULT_EXAMPLES = 3;

/** Log scale saturates at this many distinct threads in the window. */
const DISCUSSION_SCALE_MAX = 25;
/** Log scale saturates at this many mentions in the trailing 7 days. */
const MENTION_7D_SCALE_MAX = 10;
/** Diversity bonus: 0.03 per distinct source, capped at 5 sources. */
const SOURCE_BONUS_STEP = 0.03;
const SOURCE_BONUS_MAX_SOURCES = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Keeps NaN/Infinity from an upstream aggregate out of the formula. */
function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** log(1 + clamped distance from min) / log(1 + full range) -> 0..1. */
function logScale(value: number, min: number, max: number): number {
  const safe = finite(value, min);
  if (safe <= min) return 0;
  const capped = Math.min(safe, max);
  return Math.log(1 + capped - min) / Math.log(1 + max - min);
}

/**
 * Growth of the trailing 7 days versus the 7 days before, as a ratio:
 * `(mentions7d - mentionsPrev7d) / max(1, mentionsPrev7d)`, clamped to [-1, 3].
 * A brand new cluster (prev = 0) is therefore just a positive ratio, never
 * Infinity.
 */
export function computeGrowth(mentions7d: number, mentionsPrev7d: number): number {
  const current = finite(mentions7d);
  const previous = finite(mentionsPrev7d);
  const baseline = Math.max(1, previous);
  return clamp((current - previous) / baseline, -1, 3);
}

/**
 * Trend strength in [0, 1]:
 *   0.55 * growth component (growth -1..3 mapped to 0..1)
 * + 0.20 * discussion volume (log-scaled, bending down after 25 threads)
 * + 0.10 * recent volume (log-scaled, bending down after 10 mentions in 7d)
 * + 0.15 * acceleration: 24h mentions above the 7d daily pace
 *
 * Acceleration is 0 when the caller does not report a 24h count.
 */
export function computeTrendScore(input: TrendInput): number {
  const growth = computeGrowth(input.mentions7d, input.mentionsPrev7d);
  const growthComponent = clamp((growth + 1) / 4, 0, 1);
  const volumeComponent = logScale(finite(input.discussionCount), 1, DISCUSSION_SCALE_MAX);
  const recencyComponent = logScale(finite(input.mentions7d), 0, MENTION_7D_SCALE_MAX);

  const dailyPace = finite(input.mentions7d) / 7;
  const last24h = input.mentions24h === undefined ? dailyPace : finite(input.mentions24h);
  const acceleration = clamp((last24h - dailyPace) / Math.max(1, dailyPace), 0, 1);

  return clamp(
    0.55 * growthComponent + 0.2 * volumeComponent + 0.1 * recencyComponent + 0.15 * acceleration,
    0,
    1,
  );
}

/**
 * Explainable opportunity score, integer 0..100:
 *
 *   quality   = 0.60 * max_score/100 + 0.40 * avg_score/100
 *   frequency = log-scaled discussion count            (1..25 threads -> 0..1)
 *   buying    = max_buying_intent/5
 *   manual    = max_manual_work/5
 *   severity  = max_severity/5
 *
 *   base      = 0.45*quality + 0.15*frequency + 0.15*buying + 0.10*manual + 0.15*severity
 *   trend     = 0.7 + 0.8 * computeTrendScore(input)                    (0.7 .. 1.5)
 *   diversity = sourceCount >= 2 ? min(sourceCount, 5) * 0.03 : 0       (0 .. 0.15)
 *
 *   score     = round(clamp((base * trend + diversity) * 100, 0, 100))
 *
 * Frequency uses the number of distinct discussions, not raw mentions, so a
 * single long thread with many replies can never inflate a cluster.
 */
export function computeOpportunityScore(stats: ClusterStatsRow, trend: TrendInput): number {
  const quality =
    0.6 * clamp(finite(stats.max_score) / 100, 0, 1) + 0.4 * clamp(finite(stats.avg_score) / 100, 0, 1);
  const frequency = logScale(finite(trend.discussionCount), 1, DISCUSSION_SCALE_MAX);
  const buying = clamp(finite(stats.max_buying_intent) / 5, 0, 1);
  const manual = clamp(finite(stats.max_manual_work) / 5, 0, 1);
  const severity = clamp(finite(stats.max_severity) / 5, 0, 1);

  const base = 0.45 * quality + 0.15 * frequency + 0.15 * buying + 0.1 * manual + 0.15 * severity;
  const trendFactor = 0.7 + 0.8 * computeTrendScore(trend);
  const diversity =
    trend.sourceCount >= 2 ? Math.min(finite(trend.sourceCount), SOURCE_BONUS_MAX_SOURCES) * SOURCE_BONUS_STEP : 0;

  return clamp(Math.round((base * trendFactor + diversity) * 100), 0, 100);
}

/** "inventory-sync-multi-location" -> "Inventory sync multi location". */
function humanizeProblemKey(problemKey: string): string {
  const words = problemKey.split("-").filter((word) => word !== "");
  if (words.length === 0) return problemKey;
  return words.map((word, index) => (index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word)).join(" ");
}

/**
 * Deterministic one-line summary (pain_clusters rows may be stale or absent, so
 * the ranked view never depends on a per-cluster query).
 */
function buildSummary(stats: ClusterStatsRow): string {
  const name = humanizeProblemKey(stats.problem_key);
  const category = stats.category === null || stats.category === "" ? "other" : stats.category;
  const mentions = stats.mentions === 1 ? "1 mention" : `${stats.mentions} mentions`;
  const avg = Math.round(finite(stats.avg_score) * 10) / 10;
  const peak = Math.round(finite(stats.max_score) * 10) / 10;
  return `${name}: ${mentions} in ${category}, average score ${avg}, peak ${peak}.`;
}

/** Groups sample signals by cluster: deduped by url, capped per cluster. */
function groupExamples(
  samples: readonly {
    problem_key: string;
    post_id: string;
    url: string;
    source: string;
    title: string | null;
    snippet: string;
  }[],
  perCluster: number,
): Map<string, ExamplePost[]> {
  const grouped = new Map<string, ExamplePost[]>();
  const seenUrls = new Map<string, Set<string>>();

  for (const sample of samples) {
    const urls = seenUrls.get(sample.problem_key) ?? new Set<string>();
    if (urls.has(sample.url)) continue;

    const examples = grouped.get(sample.problem_key) ?? [];
    if (examples.length >= perCluster) continue;

    urls.add(sample.url);
    seenUrls.set(sample.problem_key, urls);
    examples.push({
      postId: sample.post_id,
      url: sample.url,
      source: sample.source,
      title: sample.title,
      snippet: sample.snippet,
    });
    grouped.set(sample.problem_key, examples);
  }

  return grouped;
}

/**
 * Ranks the trailing window's clusters for /opportunities and the digest.
 *
 * Fixed query count (six set-based reads, no per-cluster queries), sorted by
 * score desc, filtered by `minScore`, then sliced to `limit`.
 */
export async function rankClustersFromDb(db: D1Database, options: RankOptions): Promise<RankedCluster[]> {
  const now = options.now;
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const limit = Math.max(0, Math.trunc(options.limit ?? DEFAULT_LIMIT));
  const minScore = options.minScore ?? 0;
  const examplesPerCluster = Math.max(0, Math.trunc(options.examplesPerCluster ?? DEFAULT_EXAMPLES));

  const windowStart = now - windowDays * DAY_MS;
  const dayAgo = now - DAY_MS;
  const sevenDaysAgo = now - 7 * DAY_MS;
  const fourteenDaysAgo = now - 14 * DAY_MS;

  const [statsRows, mentions24h, mentions7d, mentionsPrev7d, sourceCounts, samples] = await Promise.all([
    getClusterStatsRows(db, windowStart),
    getMentionCounts(db, dayAgo, now),
    getMentionCounts(db, sevenDaysAgo, now),
    getMentionCounts(db, fourteenDaysAgo, sevenDaysAgo),
    getClusterSourceCounts(db, windowStart),
    getSampleSignals(db, windowStart),
  ]);

  const examplesByCluster = groupExamples(samples, examplesPerCluster);

  const ranked: RankedCluster[] = [];
  for (const stats of statsRows) {
    const problemKey = stats.problem_key;
    const current24h = mentions24h.get(problemKey) ?? 0;
    const current7d = mentions7d.get(problemKey) ?? 0;
    const previous7d = mentionsPrev7d.get(problemKey) ?? 0;
    const sources: Record<string, number> = sourceCounts.get(problemKey) ?? {};
    const sourceKeys = Object.keys(sources);
    const sourceCount = sourceKeys.length > 0 ? sourceKeys.length : Math.trunc(finite(stats.source_count));
    const discussionCount = Math.trunc(finite(stats.discussion_count));

    const trend: TrendInput = {
      mentions: stats.mentions,
      mentions7d: current7d,
      mentionsPrev7d: previous7d,
      mentions24h: current24h,
      sourceCount,
      discussionCount,
    };

    const score = computeOpportunityScore(stats, trend);
    if (score < minScore) continue;

    ranked.push({
      problemKey,
      category: stats.category,
      summary: buildSummary(stats),
      score,
      mentions: stats.mentions,
      mentions24h: current24h,
      avgScore: stats.avg_score,
      maxScore: stats.max_score,
      growth: computeGrowth(current7d, previous7d),
      mentions7d: current7d,
      mentionsPrev7d: previous7d,
      buyingIntent: stats.max_buying_intent,
      manualWork: stats.max_manual_work,
      severity: stats.max_severity,
      sources,
      sourceCount,
      discussionCount,
      firstSeen: stats.first_seen,
      lastSeen: stats.last_seen,
      examplePosts: examplesByCluster.get(problemKey) ?? [],
    });
  }

  ranked.sort((a, b) => b.score - a.score || b.mentions - a.mentions || a.problemKey.localeCompare(b.problemKey));
  return ranked.slice(0, limit);
}
