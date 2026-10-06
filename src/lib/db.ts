/**
 * D1 data access layer.
 *
 * Rules:
 *  - every query is a prepared statement with bound parameters
 *  - no N+1 loops: aggregate queries return per-cluster maps in one round trip
 *  - all writes are idempotent (`INSERT OR IGNORE`, upserts)
 */

import type {
  ClusterRow,
  ClusterStatsRow,
  ExamplePost,
  NormalizedPost,
  PainSignalInput,
  PainSignalRow,
  PostRow,
  PostStatus,
} from "../types";

/** Deterministic id so re-running collectors never duplicates a post. */
export function stableId(source: string, externalId: string): string {
  const input = `${source.toLowerCase()}:${externalId}`;
  // FNV-1a 64-bit, hex encoded. Sync + dependency free (works inside Workers).
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0") + input.length.toString(16);
}

export interface InsertPostsResult {
  inserted: number;
  duplicates: number;
  ids: string[];
}

export async function insertPostsIgnore(
  db: D1Database,
  posts: readonly NormalizedPost[],
): Promise<InsertPostsResult> {
  if (posts.length === 0) return { inserted: 0, duplicates: 0, ids: [] };

  const statement = db.prepare(
    `INSERT OR IGNORE INTO posts
       (id, external_id, source, url, title, content, author, created_at, fetched_at, rule_score, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const batch = posts.map((post) =>
    statement.bind(
      post.id,
      post.externalId,
      post.source,
      post.url,
      post.title,
      post.content,
      post.author,
      post.createdAt,
      post.fetchedAt,
      0,
      "new" satisfies PostStatus,
    ),
  );

  const results = await db.batch(batch);
  let inserted = 0;
  const ids: string[] = [];
  results.forEach((result, index) => {
    if ((result.meta?.changes ?? 0) > 0) {
      inserted += 1;
      ids.push(posts[index]!.id);
    }
  });
  return { inserted, duplicates: posts.length - inserted, ids };
}

export async function getPost(db: D1Database, id: string): Promise<PostRow | null> {
  const row = await db.prepare(`SELECT * FROM posts WHERE id = ?`).bind(id).first<PostRow>();
  return row ?? null;
}

export async function getPostsByIds(
  db: D1Database,
  ids: readonly string[],
): Promise<PostRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await db
    .prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<PostRow>();
  return result.results ?? [];
}

export async function markPostsStatus(
  db: D1Database,
  ids: readonly string[],
  status: PostStatus,
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await db
    .prepare(
      `UPDATE posts SET status = ?, rule_score = CASE WHEN ? = 'filtered' THEN rule_score ELSE rule_score END
       WHERE id IN (${placeholders})`,
    )
    .bind(status, status, ...ids)
    .run();
}

export async function updatePostRuleScore(
  db: D1Database,
  id: string,
  ruleScore: number,
  status: PostStatus,
): Promise<void> {
  await db
    .prepare(`UPDATE posts SET rule_score = ?, status = ? WHERE id = ?`)
    .bind(ruleScore, status, id)
    .run();
}

export async function getCursor(db: D1Database, sourceKey: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT cursor FROM source_cursors WHERE source_key = ?`)
    .bind(sourceKey)
    .first<{ cursor: string | null }>();
  return row?.cursor ?? null;
}

export async function setCursor(
  db: D1Database,
  sourceKey: string,
  cursor: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_cursors (source_key, cursor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    )
    .bind(sourceKey, cursor, now)
    .run();
}

export async function countPostsByStatus(
  db: D1Database,
  status: PostStatus,
  sinceTs: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM posts WHERE status = ? AND fetched_at >= ?`)
    .bind(status, sinceTs)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** Increments today's AI item counter and returns the new total. */
export async function incrementAiUsage(
  db: D1Database,
  day: string,
  items: number,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO ai_usage (day, items) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET items = items + excluded.items
       RETURNING items`,
    )
    .bind(day, items)
    .first<{ items: number }>();
  return row?.items ?? items;
}

export async function getAiUsage(db: D1Database, day: string): Promise<number> {
  const row = await db
    .prepare(`SELECT items FROM ai_usage WHERE day = ?`)
    .bind(day)
    .first<{ items: number }>();
  return row?.items ?? 0;
}

/** Stores a signal. Returns false when the post already produced one. */
export async function insertSignalIfNew(
  db: D1Database,
  signal: PainSignalInput,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO pain_signals
         (post_id, category, problem_key, problem, current_workaround, desired_outcome,
          severity, buying_intent, manual_work, opportunity_score, software_solvable,
          explicit_app_request, evidence, keywords_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      signal.postId,
      signal.category,
      signal.problemKey,
      signal.problem,
      signal.currentWorkaround,
      signal.desiredOutcome,
      signal.severity,
      signal.buyingIntent,
      signal.manualWork,
      signal.opportunityScore,
      signal.softwareSolvable ? 1 : 0,
      signal.explicitAppRequest ? 1 : 0,
      signal.evidence,
      JSON.stringify(signal.keywords),
      now,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function getSignalForPost(
  db: D1Database,
  postId: string,
): Promise<PainSignalRow | null> {
  const row = await db
    .prepare(`SELECT * FROM pain_signals WHERE post_id = ?`)
    .bind(postId)
    .first<PainSignalRow>();
  return row ?? null;
}

const CLUSTER_STATS_SQL = `
  SELECT
    s.problem_key                                   AS problem_key,
    MAX(s.category)                                 AS category,
    COUNT(*)                                        AS mentions,
    AVG(s.opportunity_score)                        AS avg_score,
    MAX(s.opportunity_score)                        AS max_score,
    MIN(s.created_at)                               AS first_seen,
    MAX(s.created_at)                               AS last_seen,
    MAX(s.severity)                                 AS max_severity,
    MAX(s.buying_intent)                            AS max_buying_intent,
    MAX(s.manual_work)                              AS max_manual_work,
    SUM(s.explicit_app_request)                     AS app_requests,
    COUNT(DISTINCT p.source)                        AS source_count,
    COUNT(DISTINCT s.post_id)                       AS discussion_count
  FROM pain_signals s
  JOIN posts p ON p.id = s.post_id
  WHERE s.created_at >= ?
  GROUP BY s.problem_key
  ORDER BY max_score DESC, mentions DESC
  LIMIT ?
`;

export async function getClusterStatsRows(
  db: D1Database,
  sinceTs: number,
  limit = 500,
): Promise<ClusterStatsRow[]> {
  const result = await db.prepare(CLUSTER_STATS_SQL).bind(sinceTs, limit).all<ClusterStatsRow>();
  return result.results ?? [];
}

/** mentions per problem_key between [fromTs, toTs) — single query, no N+1. */
export async function getMentionCounts(
  db: D1Database,
  fromTs: number,
  toTs: number,
): Promise<Map<string, number>> {
  const result = await db
    .prepare(
      `SELECT problem_key, COUNT(*) AS mentions FROM pain_signals
       WHERE created_at >= ? AND created_at < ?
       GROUP BY problem_key`,
    )
    .bind(fromTs, toTs)
    .all<{ problem_key: string; mentions: number }>();

  const counts = new Map<string, number>();
  for (const row of result.results ?? []) counts.set(row.problem_key, row.mentions);
  return counts;
}

/** per-cluster source breakdown for the window — single query, no N+1. */
export async function getClusterSourceCounts(
  db: D1Database,
  sinceTs: number,
): Promise<Map<string, Record<string, number>>> {
  const result = await db
    .prepare(
      `SELECT s.problem_key AS problem_key, p.source AS source, COUNT(*) AS mentions
       FROM pain_signals s JOIN posts p ON p.id = s.post_id
       WHERE s.created_at >= ?
       GROUP BY s.problem_key, p.source`,
    )
    .bind(sinceTs)
    .all<{ problem_key: string; source: string; mentions: number }>();

  const out = new Map<string, Record<string, number>>();
  for (const row of result.results ?? []) {
    const bucket = out.get(row.problem_key) ?? {};
    bucket[row.source] = row.mentions;
    out.set(row.problem_key, bucket);
  }
  return out;
}

/** Highest scoring signals in the window, used to attach example posts. */
export async function getSampleSignals(
  db: D1Database,
  sinceTs: number,
  limit = 300,
): Promise<
  { problem_key: string; post_id: string; url: string; source: string; title: string | null; snippet: string }[]
> {
  const result = await db
    .prepare(
      `SELECT s.problem_key AS problem_key, s.post_id AS post_id, p.url AS url, p.source AS source,
              p.title AS title, substr(p.content, 1, 280) AS snippet
       FROM pain_signals s JOIN posts p ON p.id = s.post_id
       WHERE s.created_at >= ?
       ORDER BY s.opportunity_score DESC, s.created_at DESC
       LIMIT ?`,
    )
    .bind(sinceTs, limit)
    .all<{
      problem_key: string;
      post_id: string;
      url: string;
      source: string;
      title: string | null;
      snippet: string;
    }>();
  return result.results ?? [];
}

export async function upsertCluster(
  db: D1Database,
  cluster: {
    problemKey: string;
    name: string | null;
    summary: string | null;
    category: string | null;
    mentions: number;
    avgScore: number;
    maxScore: number;
    firstSeen: number;
    lastSeen: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pain_clusters
         (problem_key, name, summary, category, mentions, avg_score, max_score, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(problem_key) DO UPDATE SET
         name = COALESCE(excluded.name, pain_clusters.name),
         summary = COALESCE(excluded.summary, pain_clusters.summary),
         category = COALESCE(excluded.category, pain_clusters.category),
         mentions = excluded.mentions,
         avg_score = excluded.avg_score,
         max_score = excluded.max_score,
         first_seen = MIN(pain_clusters.first_seen, excluded.first_seen),
         last_seen = MAX(pain_clusters.last_seen, excluded.last_seen)`,
    )
    .bind(
      cluster.problemKey,
      cluster.name,
      cluster.summary,
      cluster.category,
      cluster.mentions,
      cluster.avgScore,
      cluster.maxScore,
      cluster.firstSeen,
      cluster.lastSeen,
    )
    .run();
}

export async function getCluster(db: D1Database, problemKey: string): Promise<ClusterRow | null> {
  const row = await db
    .prepare(`SELECT * FROM pain_clusters WHERE problem_key = ?`)
    .bind(problemKey)
    .first<ClusterRow>();
  return row ?? null;
}

export async function listClusters(db: D1Database, limit = 100): Promise<ClusterRow[]> {
  const result = await db
    .prepare(`SELECT * FROM pain_clusters ORDER BY max_score DESC, mentions DESC LIMIT ?`)
    .bind(limit)
    .all<ClusterRow>();
  return result.results ?? [];
}

export async function getLastAlertAt(
  db: D1Database,
  problemKey: string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT sent_at FROM alert_log WHERE problem_key = ?`)
    .bind(problemKey)
    .first<{ sent_at: number }>();
  return row?.sent_at ?? null;
}

export async function recordAlert(
  db: D1Database,
  problemKey: string,
  sentAt: number,
  score: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alert_log (problem_key, sent_at, score) VALUES (?, ?, ?)
       ON CONFLICT(problem_key) DO UPDATE SET sent_at = excluded.sent_at, score = excluded.score`,
    )
    .bind(problemKey, sentAt, score)
    .run();
}

export interface StatsCounts {
  posts24h: number;
  posts7d: number;
  aiCandidates24h: number;
  painSignals24h: number;
  painSignals7d: number;
  clustersTotal: number;
  highOpportunities7d: number;
  sources: Record<string, number>;
}

export async function getStatsCounts(
  db: D1Database,
  now: number,
  minStoreOpportunityScore: number,
): Promise<StatsCounts> {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const [posts, signals, clusters, highOpps, sources] = await db.batch([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN fetched_at >= ? THEN 1 ELSE 0 END) AS posts_24h,
           SUM(CASE WHEN fetched_at >= ? THEN 1 ELSE 0 END) AS posts_7d,
           SUM(CASE WHEN status IN ('queued','classified') AND fetched_at >= ? THEN 1 ELSE 0 END) AS candidates_24h
         FROM posts`,
      )
      .bind(dayAgo, weekAgo, dayAgo),
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS signals_24h,
           SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS signals_7d
         FROM pain_signals`,
      )
      .bind(dayAgo, weekAgo),
    db.prepare(`SELECT COUNT(*) AS total FROM pain_clusters`),
    db
      .prepare(
        `SELECT COUNT(DISTINCT problem_key) AS total FROM pain_signals
         WHERE created_at >= ? AND opportunity_score >= ?`,
      )
      .bind(weekAgo, minStoreOpportunityScore),
    db
      .prepare(`SELECT source, COUNT(*) AS total FROM posts WHERE fetched_at >= ? GROUP BY source`)
      .bind(weekAgo),
  ]);

  const postRow = (posts as D1Result<{ posts_24h: number | null; posts_7d: number | null; candidates_24h: number | null }>)
    .results?.[0];
  const signalRow = (signals as D1Result<{ signals_24h: number | null; signals_7d: number | null }>)
    .results?.[0];
  const clusterRow = (clusters as D1Result<{ total: number }>).results?.[0];
  const highRow = (highOpps as D1Result<{ total: number }>).results?.[0];

  const sourceCounts: Record<string, number> = {};
  for (const row of (sources as D1Result<{ source: string; total: number }>).results ?? []) {
    sourceCounts[row.source] = row.total;
  }

  return {
    posts24h: postRow?.posts_24h ?? 0,
    posts7d: postRow?.posts_7d ?? 0,
    aiCandidates24h: postRow?.candidates_24h ?? 0,
    painSignals24h: signalRow?.signals_24h ?? 0,
    painSignals7d: signalRow?.signals_7d ?? 0,
    clustersTotal: clusterRow?.total ?? 0,
    highOpportunities7d: highRow?.total ?? 0,
    sources: sourceCounts,
  };
}

export async function getExamplePosts(
  db: D1Database,
  problemKey: string,
  limit: number,
): Promise<ExamplePost[]> {
  const result = await db
    .prepare(
      `SELECT s.post_id AS postId, p.url AS url, p.source AS source, p.title AS title,
              substr(p.content, 1, 240) AS snippet
       FROM pain_signals s JOIN posts p ON p.id = s.post_id
       WHERE s.problem_key = ?
       ORDER BY s.opportunity_score DESC, s.created_at DESC
       LIMIT ?`,
    )
    .bind(problemKey, limit)
    .all<ExamplePost>();
  return result.results ?? [];
}
