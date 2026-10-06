/**
 * Shopify Community collector.
 *
 * LIMITATION / FRAGILITY NOTICE
 * Shopify Community runs on Discourse and exposes *undocumented* public JSON
 * endpoints (`/latest.json`, `/t/{id}.json`). They can change without notice and
 * are aggressively protected when traffic looks automated: responses may be
 * 403/503 or a non-JSON bot challenge page. This collector NEVER attempts to
 * bypass a challenge (no cookies, no auth, no retries against a challenge) — it
 * logs a warning and returns what it already collected. All endpoint knowledge
 * and JSON shape parsing is deliberately isolated in this one file so a schema
 * change is a single-file fix.
 *
 * Listing pages are read newest-first; only topics strictly newer than the
 * stored cursor are hydrated with their full topic JSON, capped per run. The
 * cursor advances only past topics that were actually emitted, so a failed run
 * never skips posts.
 */

import type { Env } from "../env";
import { loadConfig } from "../lib/config";
import { getCursor, setCursor } from "../lib/db";
import { createLogger } from "../lib/logger";
import { HttpError, isRetryableStatus, withRetry } from "../lib/retry";
import type { Collector, RawPost } from "../types";
import { cursorKey } from "./types";
import type { CollectorIo } from "./reddit";

export type { CollectorIo } from "./reddit";

const BASE_URL = "https://community.shopify.com";
const USER_AGENT =
  "MerchantSignalBot/1.0 (ecommerce pain-point research; public JSON endpoints; contact: ops@merchant-signal.invalid)";
const THROTTLE_MS = 1_000;
const RETRIES = 2;
const MAX_LISTING_PAGES = 5;
/** Hard cap on `/t/{id}.json` calls per run to keep ingestion cheap and polite. */
export const MAX_TOPIC_DETAIL_FETCHES = 30;
/** Detail HTML is stripped downstream; cap here to keep D1 rows bounded. */
const MAX_TOPIC_CONTENT_CHARS = 6_000;

/** Thrown when an endpoint answers with a bot challenge instead of JSON. */
class ShopifyChallengeError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ShopifyChallengeError";
    this.status = status;
  }
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Topic as seen in a listing, already narrowed from `unknown`. */
interface ShopifyTopic {
  id: number;
  slug: string;
  title: string;
  createdAt: number;
}

function resolveCreatedAt(record: Record<string, unknown>): number {
  const created = Date.parse(readString(record, "created_at"));
  if (Number.isFinite(created)) return created;
  const lastPosted = record["last_posted_at"];
  if (typeof lastPosted === "number" && Number.isFinite(lastPosted)) return lastPosted * 1000;
  if (typeof lastPosted === "string") {
    const parsed = Date.parse(lastPosted);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** Extracts the topics of a `latest.json` payload; ignores unknown shapes. */
function parseTopics(payload: unknown): ShopifyTopic[] {
  const root = asRecord(payload);
  const topicList = root ? asRecord(root.topic_list) : null;
  const rawTopics = topicList ? topicList.topics : undefined;
  if (!Array.isArray(rawTopics)) return [];

  const topics: ShopifyTopic[] = [];
  for (const entry of rawTopics) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = readNumber(record, "id");
    const title = readString(record, "title");
    if (id <= 0 || title === "") continue;
    topics.push({ id, slug: readString(record, "slug"), title, createdAt: resolveCreatedAt(record) });
  }
  return topics;
}

/** First post of a full topic payload (the topic body + its author). */
function parseFirstPost(payload: unknown): { author: string; cooked: string } | null {
  const root = asRecord(payload);
  const stream = root ? asRecord(root.post_stream) : null;
  const posts = stream ? stream.posts : undefined;
  if (!Array.isArray(posts) || posts.length === 0) return null;
  const first = asRecord(posts[0]);
  if (!first) return null;
  return { author: readString(first, "username"), cooked: readString(first, "cooked") };
}

interface ShopifyCursor {
  id: number;
  createdAt: number;
}

function decodeCursor(raw: string | null): ShopifyCursor | null {
  if (raw === null || raw === "") return null;
  try {
    const record = asRecord(JSON.parse(raw) as unknown);
    if (!record) return null;
    const createdAt = readNumber(record, "lastCreatedAt");
    const id = readNumber(record, "lastTopicId");
    if (createdAt === 0 && id === 0) return null;
    return { id, createdAt };
  } catch {
    // Corrupted cursor: treat as absent so the next run simply re-reads the listing.
    return null;
  }
}

function isNewer(candidate: ShopifyCursor, reference: ShopifyCursor): boolean {
  if (candidate.createdAt !== reference.createdAt) return candidate.createdAt > reference.createdAt;
  return candidate.id > reference.id;
}

function toRawPost(topic: ShopifyTopic, firstPost: { author: string; cooked: string }): RawPost {
  const combined = `${topic.title}\n\n${firstPost.cooked}`;
  const content = combined.length > MAX_TOPIC_CONTENT_CHARS ? combined.slice(0, MAX_TOPIC_CONTENT_CHARS) : combined;
  const path = topic.slug === "" ? `/t/${topic.id}` : `/t/${topic.slug}/${topic.id}`;
  return {
    id: String(topic.id),
    externalId: String(topic.id),
    source: "shopify",
    url: `${BASE_URL}${path}`,
    title: topic.title,
    content,
    author: firstPost.author === "" ? undefined : firstPost.author,
    createdAt: topic.createdAt,
  };
}

export function createShopifyCollector(options: CollectorIo = {}): Collector<Env> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const logger = createLogger("collector.shopify");

  const requestOptions = {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  };

  const retryOptions = {
    retries: RETRIES,
    sleep,
    isRetryable: (error: unknown): boolean => error instanceof HttpError && isRetryableStatus(error.status),
  };

  return {
    source: "shopify",

    async collect(env: Env): Promise<RawPost[]> {
      const config = loadConfig(env);
      const pages = Math.min(Math.max(1, Math.floor(config.shopifyCommunity.pages)), MAX_LISTING_PAGES);
      const key = cursorKey("shopify", "community");

      // Sequential requests, one second apart; the first request is not delayed.
      let requested = false;
      const throttle = async (): Promise<void> => {
        if (requested) await sleep(THROTTLE_MS);
        requested = true;
      };

      async function requestJson(url: string): Promise<unknown> {
        await throttle();
        return withRetry(async () => {
          const response = await fetchImpl(url, requestOptions);
          if (response.status === 403 || response.status === 503) {
            throw new ShopifyChallengeError(`HTTP ${response.status} (bot challenge)`, response.status);
          }
          const text = await response.text();
          if (!response.ok) throw new HttpError(response.status, text);
          try {
            return JSON.parse(text) as unknown;
          } catch {
            throw new ShopifyChallengeError("non-JSON response (bot challenge)", response.status);
          }
        }, retryOptions);
      }

      const listingUrls: string[] = [];
      for (let page = 1; page <= pages; page++) {
        listingUrls.push(`${BASE_URL}/latest.json?order=created&ascending=false&page=${page}`);
        listingUrls.push(`${BASE_URL}/latest.json?page=${page}`);
      }

      const topics = new Map<number, ShopifyTopic>();
      for (const url of listingUrls) {
        try {
          for (const topic of parseTopics(await requestJson(url))) topics.set(topic.id, topic);
        } catch (error) {
          if (error instanceof ShopifyChallengeError) {
            logger.warn("shopify.listing_challenge", { status: error.status, url });
          } else {
            logger.warn("shopify.listing_failed", {
              url,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }
      }

      const cursor = decodeCursor(await getCursor(env.DB, key));
      const candidates = [...topics.values()]
        .filter((topic) => cursor === null || isNewer({ id: topic.id, createdAt: topic.createdAt }, cursor))
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
        .slice(0, MAX_TOPIC_DETAIL_FETCHES);

      const collected: RawPost[] = [];
      let newest: ShopifyCursor | null = cursor;

      for (const topic of candidates) {
        let payload: unknown;
        try {
          payload = await requestJson(`${BASE_URL}/t/${topic.id}.json`);
        } catch (error) {
          if (error instanceof ShopifyChallengeError) {
            logger.warn("shopify.topic_challenge", { status: error.status, topicId: topic.id });
          } else {
            logger.warn("shopify.topic_failed", {
              topicId: topic.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          // Stop at the first failure so the cursor never advances past a topic
          // that was not stored; the topic is retried on the next run.
          break;
        }

        const firstPost = parseFirstPost(payload);
        if (!firstPost) {
          logger.warn("shopify.topic_shape", { topicId: topic.id });
          break;
        }

        collected.push(toRawPost(topic, firstPost));
        if (newest === null || isNewer({ id: topic.id, createdAt: topic.createdAt }, newest)) {
          newest = { id: topic.id, createdAt: topic.createdAt };
        }
      }

      if (newest !== null && (cursor === null || isNewer(newest, cursor))) {
        await setCursor(
          env.DB,
          key,
          JSON.stringify({ lastCreatedAt: newest.createdAt, lastTopicId: newest.id }),
          Date.now(),
        );
      }

      logger.info("shopify.collected", { listed: topics.size, emitted: collected.length });
      return collected;
    },
  };
}
