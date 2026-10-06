/**
 * Shared domain types for MerchantSignal.
 *
 * Everything that crosses a module boundary is defined here so collectors,
 * processing, digest and the worker entrypoint can be developed and tested
 * independently.
 */

/** Lifecycle of a single collected post. */
export type PostStatus =
  | "new" // collected + normalized, awaiting/queued for AI
  | "queued" // pushed to the PAIN_QUEUE
  | "filtered" // rejected by the deterministic rule filter
  | "classified" // AI processed (signal stored, or explicitly not a pain)
  | "deferred" // AI budget exhausted; keep for a later run
  | "failed"; // AI or validation failed permanently

export const POST_STATUSES: readonly PostStatus[] = [
  "new",
  "queued",
  "filtered",
  "classified",
  "deferred",
  "failed",
] as const;

/** Canonical category list. Mirrors the classifier prompt. */
export const CATEGORIES = [
  "inventory",
  "fulfillment",
  "shipping",
  "returns",
  "refunds",
  "chargebacks",
  "fraud",
  "checkout",
  "payments",
  "subscriptions",
  "customer-support",
  "crm",
  "email-marketing",
  "sms-marketing",
  "advertising",
  "attribution",
  "analytics",
  "reporting",
  "seo",
  "conversion",
  "pricing",
  "discounts",
  "bundles",
  "product-management",
  "catalog",
  "merchandising",
  "international-commerce",
  "taxes",
  "accounting",
  "finance",
  "marketplaces",
  "integrations",
  "automation",
  "operations",
  "supplier-management",
  "dropshipping",
  "wholesale-b2b",
  "loyalty",
  "reviews",
  "upsell-cross-sell",
  "theme-storefront",
  "shopify-admin",
  "app-management",
  "data-sync",
  "compliance",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Raw output of a collector, before normalization. */
export interface RawPost {
  id: string;
  externalId: string;
  source: string;
  url: string;
  title?: string;
  content: string;
  author?: string;
  createdAt: number;
}

/**
 * Collector contract. New sources (X, Facebook, ...) only need to implement
 * this and be registered in src/collectors/index.ts; the rest of the pipeline
 * is untouched.
 */
export interface Collector<EnvType = unknown> {
  source: string;
  collect(env: EnvType): Promise<RawPost[]>;
}

/** Fully normalized post, ready for the rule filter. */
export interface NormalizedPost {
  id: string;
  externalId: string;
  source: string;
  url: string;
  title: string | null;
  content: string;
  author: string | null;
  createdAt: number;
  fetchedAt: number;
}

/** posts table row. */
export interface PostRow {
  id: string;
  external_id: string;
  source: string;
  url: string;
  title: string | null;
  content: string;
  author: string | null;
  created_at: number;
  fetched_at: number;
  rule_score: number;
  status: PostStatus;
}

/** pain_signals table row. */
export interface PainSignalRow {
  id: number;
  post_id: string;
  category: string | null;
  problem_key: string;
  problem: string | null;
  current_workaround: string | null;
  desired_outcome: string | null;
  severity: number;
  buying_intent: number;
  manual_work: number;
  opportunity_score: number;
  software_solvable: number;
  explicit_app_request: number;
  evidence: string | null;
  keywords_json: string;
  created_at: number;
}

/** Classified signal produced by the AI classifier (validated by Zod). */
export interface PainSignalInput {
  postId: string;
  category: Category | null;
  problemKey: string;
  problem: string | null;
  currentWorkaround: string | null;
  desiredOutcome: string | null;
  severity: number;
  buyingIntent: number;
  manualWork: number;
  opportunityScore: number;
  softwareSolvable: boolean;
  explicitAppRequest: boolean;
  evidence: string | null;
  keywords: string[];
}

/** pain_clusters table row. */
export interface ClusterRow {
  id: number;
  problem_key: string;
  name: string | null;
  summary: string | null;
  category: string | null;
  mentions: number;
  avg_score: number;
  max_score: number;
  first_seen: number;
  last_seen: number;
}

/** Aggregate produced by a single GROUP BY pass over pain_signals. */
export interface ClusterStatsRow {
  problem_key: string;
  category: string | null;
  mentions: number;
  avg_score: number;
  max_score: number;
  first_seen: number;
  last_seen: number;
  max_severity: number;
  max_buying_intent: number;
  max_manual_work: number;
  app_requests: number;
  source_count: number;
  discussion_count: number;
}

/** Ranked cluster returned by /opportunities and used by the digest. */
export interface RankedCluster {
  problemKey: string;
  category: string | null;
  summary: string;
  score: number;
  mentions: number;
  mentions24h: number;
  avgScore: number;
  maxScore: number;
  growth: number;
  mentions7d: number;
  mentionsPrev7d: number;
  buyingIntent: number;
  manualWork: number;
  severity: number;
  sources: Record<string, number>;
  sourceCount: number;
  discussionCount: number;
  firstSeen: number;
  lastSeen: number;
  examplePosts: ExamplePost[];
}

export interface ExamplePost {
  postId: string;
  url: string;
  source: string;
  title: string | null;
  snippet: string;
}

/** Queue payload. */
export interface PainQueueMessage {
  postId: string;
  source: string;
  ruleScore: number;
  enqueuedAt: number;
}

/** Result of the deterministic rule filter. */
export interface RuleResult {
  score: number;
  matched: string[];
  blocked: boolean;
  blockedReason: string | null;
}
