/**
 * Cluster aggregation.
 *
 * Refreshes the `pain_clusters` materialized view from the window's pain
 * signals: one GROUP BY pass (via {@link getClusterStatsRows}) plus one
 * idempotent upsert per cluster. Name and summary are derived deterministically
 * from the data — no AI call, so repeated runs produce identical rows.
 */

import { getClusterStatsRows, upsertCluster } from "../lib/db";
import type { ClusterStatsRow } from "../types";

export interface AggregationResult {
  clusters: number;
  signals: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;

/** "inventory-sync-multi-location" -> "Inventory sync multi location". */
function humanizeProblemKey(problemKey: string): string {
  const words = problemKey.split("-").filter((word) => word !== "");
  if (words.length === 0) return problemKey;
  return words.map((word, index) => (index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word)).join(" ");
}

function buildSummary(row: ClusterStatsRow): string {
  const category = row.category === null || row.category === "" ? "other" : row.category;
  const mentions = row.mentions === 1 ? "1 mention" : `${row.mentions} mentions`;
  const avg = Math.round(row.avg_score * 10) / 10;
  const peak = Math.round(row.max_score * 10) / 10;
  return `${mentions} in ${category}, average score ${avg}, peak ${peak}.`;
}

/**
 * Rebuilds `pain_clusters` for the trailing window. Idempotent: clusters are
 * upserted by problem_key and nothing is written when the window is empty.
 */
export async function aggregateClusters(
  db: D1Database,
  now: number,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<AggregationResult> {
  const sinceTs = now - windowDays * DAY_MS;
  const rows = await getClusterStatsRows(db, sinceTs);
  if (rows.length === 0) return { clusters: 0, signals: 0 };

  let signals = 0;
  for (const row of rows) {
    await upsertCluster(db, {
      problemKey: row.problem_key,
      category: row.category,
      mentions: row.mentions,
      avgScore: row.avg_score,
      maxScore: row.max_score,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      name: humanizeProblemKey(row.problem_key),
      summary: buildSummary(row),
    });
    signals += row.mentions;
  }

  return { clusters: rows.length, signals };
}
