import type { PainQueueMessage } from "./types";

/**
 * Worker bindings + configuration.
 *
 * Secrets (AI_API_KEY, TELEGRAM_BOT_TOKEN, ADMIN_API_KEY, REDDIT_CLIENT_SECRET)
 * are provided by Cloudflare Secrets and never appear in wrangler.jsonc.
 */
export interface Env {
  DB: D1Database;
  PAIN_QUEUE: Queue<PainQueueMessage>;

  // --- AI provider (OpenAI compatible) ---
  AI_BASE_URL: string;
  AI_API_KEY: string;
  AI_MODEL: string;
  /** "responses" (default) or "chat_completions". */
  AI_API_STYLE?: string;
  AI_TIMEOUT_MS?: string;
  AI_MAX_RETRIES?: string;
  AI_BATCH_SIZE?: string;
  AI_CONCURRENCY?: string;

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;

  // --- Admin API ---
  ADMIN_API_KEY: string;

  // --- Reddit ---
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_USER_AGENT?: string;
  SUBREDDITS?: string;
  REDDIT_POSTS_PER_SUBREDDIT?: string;

  // --- Shopify Community ---
  SHOPIFY_COMMUNITY_PAGES?: string;

  // --- Cost controls ---
  MAX_AI_ITEMS_PER_DAY?: string;
  MIN_RULE_SCORE?: string;
  MIN_STORE_OPPORTUNITY_SCORE?: string;
  MIN_DIGEST_OPPORTUNITY_SCORE?: string;
  EXTRA_RULE_PATTERNS?: string;

  // --- Alerts ---
  ENABLE_REALTIME_ALERTS?: string;
  REALTIME_ALERT_THRESHOLD?: string;
  ALERT_COOLDOWN_HOURS?: string;

  // --- Digest ---
  DIGEST_TIMEZONE?: string;
  DIGEST_TOP_N?: string;
  DIGEST_EMERGING_N?: string;
  DIGEST_BUYING_INTENT_N?: string;
}
