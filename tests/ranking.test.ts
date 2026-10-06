/**
 * Ranking tests.
 *
 * Pure-function coverage for the scoring formula plus integration coverage for
 * `rankClustersFromDb` against a fake D1 that dispatches on the SQL text sent
 * by src/lib/db.ts (matched on stable substrings).
 */

import { describe, expect, it } from "vitest";

import {
  computeGrowth,
  computeOpportunityScore,
  computeTrendScore,
  rankClustersFromDb,
  type RankOptions,
  type TrendInput,
} from "../src/processing/ranking";
import type { ClusterStatsRow } from "../src/types";

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;

function clusterStats(
  overrides: Partial<ClusterStatsRow> & { problem_key: string },
): ClusterStatsRow {
  return {
    category: "inventory",
    mentions: 10,
    avg_score: 50,
    max_score: 60,
    first_seen: NOW - 20 * DAY_MS,
    last_seen: NOW - DAY_MS,
    max_severity: 3,
    max_buying_intent: 3,
    max_manual_work: 3,
    app_requests: 1,
    source_count: 1,
    discussion_count: 5,
    ...overrides,
  };
}

function trend(overrides: Partial<TrendInput> = {}): TrendInput {
  return {
    mentions: 10,
    mentions7d: 5,
    mentionsPrev7d: 5,
    sourceCount: 1,
    discussionCount: 5,
    ...overrides,
  };
}

describe("computeGrowth", () => {
  it("returns a positive ratio when mentions grew", () => {
    expect(computeGrowth(10, 5)).toBe(1);
    expect(computeGrowth(7, 5)).toBeCloseTo(0.4, 10);
  });

  it("returns a negative ratio when mentions shrank", () => {
    expect(computeGrowth(2, 10)).toBeCloseTo(-0.8, 10);
  });

  it("clamps at +3", () => {
    expect(computeGrowth(100, 1)).toBe(3);
  });

  it("clamps at -1", () => {
    expect(computeGrowth(0, 10)).toBe(-1);
    expect(computeGrowth(1, 1000)).toBeGreaterThan(-1);
  });

  it("never returns Infinity or NaN when the previous window is empty", () => {
    const growth = computeGrowth(5, 0);
    expect(Number.isFinite(growth)).toBe(true);
    expect(growth).toBe(3);
    expect(computeGrowth(0, 0)).toBe(0);
    expect(Number.isFinite(computeGrowth(Number.NaN, 0))).toBe(true);
  });
});

describe("computeTrendScore", () => {
  it("stays within 0..1 across the input space", () => {
    const cases: TrendInput[] = [
      trend({ mentions: 0, mentions7d: 0, mentionsPrev7d: 0, sourceCount: 0, discussionCount: 0 }),
      trend({ mentions: 1, mentions7d: 1, mentionsPrev7d: 0, sourceCount: 1, discussionCount: 1 }),
      trend({ mentions: 100, mentions7d: 50, mentionsPrev7d: 5, sourceCount: 6, discussionCount: 40 }),
      trend({ mentions: 1_000, mentions7d: 999, mentionsPrev7d: 1, sourceCount: 20, discussionCount: 900 }),
    ];
    for (const input of cases) {
      const score = computeTrendScore(input);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("increases monotonically as growth increases (holding recency and volume fixed)", () => {
    const base = { mentions: 10, mentions7d: 10, sourceCount: 2, discussionCount: 10 };
    const cold = computeTrendScore({ ...base, mentionsPrev7d: 20 }); // growth -0.5
    const flat = computeTrendScore({ ...base, mentionsPrev7d: 10 }); // growth 0
    const hot = computeTrendScore({ ...base, mentionsPrev7d: 5 }); // growth 1
    expect(cold).toBeLessThan(flat);
    expect(flat).toBeLessThan(hot);
  });

  it("is higher when the same mentions come from more distinct discussions", () => {
    const narrow = computeTrendScore(trend({ mentions: 6, mentions7d: 6, mentionsPrev7d: 6, discussionCount: 2 }));
    const broad = computeTrendScore(trend({ mentions: 6, mentions7d: 6, mentionsPrev7d: 6, discussionCount: 20 }));
    expect(broad).toBeGreaterThan(narrow);
  });
});

describe("computeOpportunityScore", () => {
  const strongStats = clusterStats({
    problem_key: "inventory-sync-multi-location",
    max_score: 88,
    avg_score: 70,
    max_buying_intent: 4,
    max_manual_work: 4,
    max_severity: 5,
    discussion_count: 12,
  });
  const strongTrend = trend({ mentions: 25, mentions7d: 6, mentionsPrev7d: 3, sourceCount: 3, discussionCount: 12 });

  const weakStats = clusterStats({
    problem_key: "shipping-delays",
    max_score: 40,
    avg_score: 30,
    max_buying_intent: 2,
    max_manual_work: 1,
    max_severity: 2,
    discussion_count: 2,
  });
  const weakTrend = trend({ mentions: 3, mentions7d: 2, mentionsPrev7d: 2, sourceCount: 1, discussionCount: 2 });

  it("scores a strong multi-source cluster above a weak single-source one", () => {
    const strong = computeOpportunityScore(strongStats, strongTrend);
    const weak = computeOpportunityScore(weakStats, weakTrend);
    expect(strong).toBeGreaterThan(weak);
  });

  it("returns an integer clamped to 0..100 even for absurd stats", () => {
    const high = computeOpportunityScore(
      clusterStats({
        problem_key: "absurd-high",
        max_score: 1000,
        avg_score: 900,
        max_buying_intent: 99,
        max_manual_work: 99,
        max_severity: 99,
        discussion_count: 10_000,
      }),
      trend({ mentions: 999, mentions7d: 999, mentionsPrev7d: 0, sourceCount: 50, discussionCount: 10_000 }),
    );
    expect(Number.isInteger(high)).toBe(true);
    expect(high).toBeLessThanOrEqual(100);

    const low = computeOpportunityScore(
      clusterStats({
        problem_key: "absurd-low",
        max_score: -50,
        avg_score: 0,
        max_buying_intent: 0,
        max_manual_work: 0,
        max_severity: 0,
        discussion_count: 0,
      }),
      trend({ mentions: 0, mentions7d: 0, mentionsPrev7d: 0, sourceCount: 0, discussionCount: 0 }),
    );
    expect(Number.isInteger(low)).toBe(true);
    expect(low).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic for the same input", () => {
    const first = computeOpportunityScore(strongStats, strongTrend);
    const second = computeOpportunityScore(strongStats, strongTrend);
    expect(first).toBe(second);
  });
});

/* ------------------------------------------------------------------ */
/* rankClustersFromDb integration against a fake D1                    */
/* ------------------------------------------------------------------ */

interface SampleRow {
  problem_key: string;
  post_id: string;
  url: string;
  source: string;
  title: string | null;
  snippet: string;
}

interface FakeDbConfig {
  stats: ClusterStatsRow[];
  mentions24h: { problem_key: string; mentions: number }[];
  mentions7d: { problem_key: string; mentions: number }[];
  mentionsPrev7d: { problem_key: string; mentions: number }[];
  sourceCounts: { problem_key: string; source: string; mentions: number }[];
  samples: SampleRow[];
}

interface FakeStatement {
  bind(...args: unknown[]): FakeStatement;
  all(): Promise<{ results: unknown[] }>;
  first(): Promise<unknown>;
  run(): Promise<unknown>;
}

/**
 * Fake D1 that dispatches on the SQL text emitted by src/lib/db.ts. Stable
 * substrings are matched (never the whole query) so formatting changes do not
 * silently break the fake: it throws on any query it does not recognize.
 */
function makeFakeDb(config: FakeDbConfig): {
  db: D1Database;
  prepared: { sql: string; args: unknown[] }[];
} {
  const prepared: { sql: string; args: unknown[] }[] = [];

  const dispatch = (sql: string, args: readonly unknown[]): unknown[] => {
    if (sql.includes("COUNT(DISTINCT s.post_id)")) return config.stats;
    if (sql.includes("GROUP BY s.problem_key, p.source")) return config.sourceCounts;
    if (sql.includes("substr(p.content")) return config.samples;
    if (sql.includes("SELECT problem_key, COUNT(*) AS mentions")) {
      // Three callers share this SQL; route by the window start bound.
      const start = Number(args[0]);
      if (start === NOW - DAY_MS) return config.mentions24h;
      if (start === NOW - 7 * DAY_MS) return config.mentions7d;
      return config.mentionsPrev7d;
    }
    throw new Error(`unexpected SQL sent to the fake D1: ${sql.slice(0, 80)}`);
  };

  const db = {
    prepare(sql: string): FakeStatement {
      const entry = { sql, args: [] as unknown[] };
      prepared.push(entry);
      const statement: FakeStatement = {
        bind(...args: unknown[]): FakeStatement {
          entry.args = args;
          return statement;
        },
        async all(): Promise<{ results: unknown[] }> {
          return { results: dispatch(sql, entry.args) };
        },
        async first(): Promise<unknown> {
          return dispatch(sql, entry.args)[0] ?? null;
        },
        async run(): Promise<unknown> {
          return { success: true, meta: { changes: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  return { db, prepared };
}

const CLUSTER_A = "inventory-sync-multi-location";
const CLUSTER_B = "shipping-delays";

const STATS_A = clusterStats({
  problem_key: CLUSTER_A,
  category: "inventory",
  mentions: 25,
  avg_score: 70,
  max_score: 88,
  max_severity: 5,
  max_buying_intent: 4,
  max_manual_work: 4,
  app_requests: 6,
  source_count: 2, // overridden by the source-count query (3 distinct sources)
  discussion_count: 12,
  first_seen: NOW - 20 * DAY_MS,
  last_seen: NOW - DAY_MS,
});

const STATS_B = clusterStats({
  problem_key: CLUSTER_B,
  category: "shipping",
  mentions: 3,
  avg_score: 30,
  max_score: 40,
  max_severity: 2,
  max_buying_intent: 2,
  max_manual_work: 1,
  app_requests: 0,
  source_count: 1,
  discussion_count: 2,
  first_seen: NOW - 10 * DAY_MS,
  last_seen: NOW - 2 * DAY_MS,
});

const SOURCE_COUNTS = [
  { problem_key: CLUSTER_A, source: "reddit", mentions: 10 },
  { problem_key: CLUSTER_A, source: "shopify-community", mentions: 8 },
  { problem_key: CLUSTER_A, source: "x", mentions: 7 },
];

const SAMPLES: SampleRow[] = [
  { problem_key: CLUSTER_A, post_id: "a1", url: "https://ex/a1", source: "reddit", title: "A1", snippet: "snippet a1" },
  { problem_key: CLUSTER_A, post_id: "a2", url: "https://ex/a2", source: "shopify-community", title: null, snippet: "snippet a2" },
  { problem_key: CLUSTER_A, post_id: "a3", url: "https://ex/a3", source: "reddit", title: "A3", snippet: "snippet a3" },
  { problem_key: CLUSTER_A, post_id: "a1-dup", url: "https://ex/a1", source: "reddit", title: "A1 again", snippet: "dup" },
  { problem_key: CLUSTER_B, post_id: "b1", url: "https://ex/b1", source: "forums", title: "B1", snippet: "snippet b1" },
];

const BASE_CONFIG: FakeDbConfig = {
  stats: [STATS_A, STATS_B],
  mentions24h: [
    { problem_key: CLUSTER_A, mentions: 3 },
    { problem_key: CLUSTER_B, mentions: 0 },
  ],
  mentions7d: [
    { problem_key: CLUSTER_A, mentions: 6 },
    { problem_key: CLUSTER_B, mentions: 2 },
  ],
  mentionsPrev7d: [
    { problem_key: CLUSTER_A, mentions: 3 },
    { problem_key: CLUSTER_B, mentions: 2 },
  ],
  sourceCounts: SOURCE_COUNTS,
  samples: SAMPLES,
};

async function runRank(options: Partial<RankOptions> = {}, config: FakeDbConfig = BASE_CONFIG) {
  const { db, prepared } = makeFakeDb(config);
  const ranked = await rankClustersFromDb(db, { now: NOW, examplesPerCluster: 2, ...options });
  return { ranked, prepared };
}

describe("rankClustersFromDb", () => {
  it("sorts by score desc and applies minScore and limit", async () => {
    const { ranked } = await runRank();

    expect(ranked.map((cluster) => cluster.problemKey)).toEqual([CLUSTER_A, CLUSTER_B]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);

    const all = await runRank({ minScore: 0 });
    const weakScore = all.ranked[1]!.score;
    const filtered = await runRank({ minScore: weakScore + 1 });
    expect(filtered.ranked.map((cluster) => cluster.problemKey)).toEqual([CLUSTER_A]);

    const limited = await runRank({ limit: 1 });
    expect(limited.ranked.map((cluster) => cluster.problemKey)).toEqual([CLUSTER_A]);

    const none = await runRank({ limit: 0 });
    expect(none.ranked).toEqual([]);
  });

  it("computes growth and mention windows from the 7d vs previous-7d counts", async () => {
    const { ranked } = await runRank();

    const a = ranked.find((cluster) => cluster.problemKey === CLUSTER_A);
    const b = ranked.find((cluster) => cluster.problemKey === CLUSTER_B);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;

    expect(a.mentions7d).toBe(6);
    expect(a.mentionsPrev7d).toBe(3);
    expect(a.growth).toBe(computeGrowth(6, 3));
    expect(a.growth).toBe(1);

    expect(b.mentions7d).toBe(2);
    expect(b.mentionsPrev7d).toBe(2);
    expect(b.growth).toBe(computeGrowth(2, 2));
    expect(b.growth).toBe(0);
  });

  it("reports trailing 24h mentions from their own window", async () => {
    const { ranked } = await runRank();
    const a = ranked.find((cluster) => cluster.problemKey === CLUSTER_A);
    const b = ranked.find((cluster) => cluster.problemKey === CLUSTER_B);
    expect(a?.mentions24h).toBe(3);
    expect(b?.mentions24h).toBe(0);
  });

  it("wires the aggregated stats through computeOpportunityScore", async () => {
    const { ranked } = await runRank();
    const a = ranked.find((cluster) => cluster.problemKey === CLUSTER_A);
    expect(a).toBeDefined();
    if (a === undefined) return;

    expect(a.score).toBe(
      computeOpportunityScore(STATS_A, {
        mentions: STATS_A.mentions,
        mentions7d: 6,
        mentionsPrev7d: 3,
        mentions24h: 3,
        sourceCount: 3,
        discussionCount: STATS_A.discussion_count,
      }),
    );
    expect(a.summary).toBe(
      "Inventory sync multi location: 25 mentions in inventory, average score 70, peak 88.",
    );
  });

  it("reflects the source-count query in sources and sourceCount", async () => {
    const { ranked } = await runRank();

    const a = ranked.find((cluster) => cluster.problemKey === CLUSTER_A);
    const b = ranked.find((cluster) => cluster.problemKey === CLUSTER_B);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;

    expect(a.sources).toEqual({ reddit: 10, "shopify-community": 8, x: 7 });
    expect(a.sourceCount).toBe(3);

    // No source-count rows for B: falls back to the aggregate's source_count.
    expect(b.sources).toEqual({});
    expect(b.sourceCount).toBe(STATS_B.source_count);
  });

  it("attaches example posts to their own cluster, deduped by url and capped", async () => {
    const { ranked } = await runRank({ examplesPerCluster: 2 });

    const a = ranked.find((cluster) => cluster.problemKey === CLUSTER_A);
    const b = ranked.find((cluster) => cluster.problemKey === CLUSTER_B);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;

    // a3 exceeds the cap and a1-dup repeats a1's url.
    expect(a.examplePosts.map((example) => example.url)).toEqual(["https://ex/a1", "https://ex/a2"]);
    expect(a.examplePosts[0]).toEqual({
      postId: "a1",
      url: "https://ex/a1",
      source: "reddit",
      title: "A1",
      snippet: "snippet a1",
    });
    expect(a.examplePosts.some((example) => example.url === "https://ex/b1")).toBe(false);

    expect(b.examplePosts.map((example) => example.url)).toEqual(["https://ex/b1"]);
    expect(b.examplePosts.some((example) => example.url === "https://ex/a1")).toBe(false);
  });

  it("honors a smaller examplesPerCluster", async () => {
    const { ranked } = await runRank({ examplesPerCluster: 1 });
    const a = ranked.find((cluster) => cluster.problemKey === CLUSTER_A);
    expect(a).toBeDefined();
    if (a === undefined) return;
    expect(a.examplePosts.map((example) => example.url)).toEqual(["https://ex/a1"]);
  });

  it("uses a fixed number of queries regardless of cluster count (no N+1)", async () => {
    // One query per data source: cluster stats, 24h mentions, 7d mentions,
    // previous-7d mentions, per-cluster source counts and sample signals = 6 prepares.
    const small = await runRank();
    expect(small.prepared).toHaveLength(6);

    const manyStats = Array.from({ length: 40 }, (_unused, index) =>
      clusterStats({ problem_key: `cluster-${index}`, mentions: index + 1, discussion_count: index + 1 }),
    );
    const many = await runRank({}, { ...BASE_CONFIG, stats: manyStats });
    expect(many.prepared).toHaveLength(6);
  });
});
