import type { Env } from "../env";

/** Parsed, validated runtime configuration. All values have safe defaults. */
export interface AppConfig {
  ai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    apiStyle: "responses" | "chat_completions";
    timeoutMs: number;
    maxRetries: number;
    batchSize: number;
    concurrency: number;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  adminApiKey: string;
  reddit: {
    clientId: string;
    clientSecret: string;
    userAgent: string;
    subreddits: string[];
    postsPerSubreddit: number;
  };
  shopifyCommunity: {
    pages: number;
  };
  limits: {
    maxAiItemsPerDay: number;
    minRuleScore: number;
    minStoreOpportunityScore: number;
    minDigestOpportunityScore: number;
    extraRulePatterns: string[];
  };
  alerts: {
    enabled: boolean;
    threshold: number;
    cooldownHours: number;
  };
  digest: {
    timezone: string;
    topN: number;
    emergingN: number;
    buyingIntentN: number;
  };
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function str(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === "") return fallback;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadConfig(env: Env): AppConfig {
  const apiStyle = str(env.AI_API_STYLE, "responses").toLowerCase();
  return {
    ai: {
      baseUrl: str(env.AI_BASE_URL, "").replace(/\/+$/, ""),
      apiKey: str(env.AI_API_KEY, ""),
      model: str(env.AI_MODEL, ""),
      apiStyle: apiStyle === "chat_completions" ? "chat_completions" : "responses",
      timeoutMs: num(env.AI_TIMEOUT_MS, 30_000),
      maxRetries: num(env.AI_MAX_RETRIES, 2),
      batchSize: Math.max(1, num(env.AI_BATCH_SIZE, 10)),
      concurrency: Math.max(1, num(env.AI_CONCURRENCY, 2)),
    },
    telegram: {
      botToken: str(env.TELEGRAM_BOT_TOKEN, ""),
      chatId: str(env.TELEGRAM_CHAT_ID, ""),
    },
    adminApiKey: str(env.ADMIN_API_KEY, ""),
    reddit: {
      clientId: str(env.REDDIT_CLIENT_ID, ""),
      clientSecret: str(env.REDDIT_CLIENT_SECRET, ""),
      userAgent: str(env.REDDIT_USER_AGENT, "merchant-signal/1.0"),
      subreddits: list(env.SUBREDDITS, [
        "shopify",
        "ecommerce",
        "smallbusiness",
        "Entrepreneur",
        "dropship",
        "FacebookAds",
        "PPC",
      ]),
      postsPerSubreddit: num(env.REDDIT_POSTS_PER_SUBREDDIT, 50),
    },
    shopifyCommunity: {
      pages: Math.max(1, num(env.SHOPIFY_COMMUNITY_PAGES, 2)),
    },
    limits: {
      maxAiItemsPerDay: num(env.MAX_AI_ITEMS_PER_DAY, 500),
      minRuleScore: num(env.MIN_RULE_SCORE, 1),
      minStoreOpportunityScore: num(env.MIN_STORE_OPPORTUNITY_SCORE, 40),
      minDigestOpportunityScore: num(env.MIN_DIGEST_OPPORTUNITY_SCORE, 55),
      extraRulePatterns: list(env.EXTRA_RULE_PATTERNS, []),
    },
    alerts: {
      enabled: bool(env.ENABLE_REALTIME_ALERTS, false),
      threshold: num(env.REALTIME_ALERT_THRESHOLD, 90),
      cooldownHours: num(env.ALERT_COOLDOWN_HOURS, 72),
    },
    digest: {
      timezone: str(env.DIGEST_TIMEZONE, "Asia/Bangkok"),
      topN: num(env.DIGEST_TOP_N, 5),
      emergingN: num(env.DIGEST_EMERGING_N, 5),
      buyingIntentN: num(env.DIGEST_BUYING_INTENT_N, 5),
    },
  };
}
