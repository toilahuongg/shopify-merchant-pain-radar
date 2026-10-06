/**
 * Reddit collector.
 *
 * Uses the OAuth2 client-credentials flow (app-only token) and reads
 * `r/{subreddit}/new` listings. Only posts strictly newer than the per-subreddit
 * cursor are emitted; the cursor is advanced after a successful listing so a
 * failed listing never causes posts to be skipped.
 *
 * Network access is injected (`fetchImpl`, `sleep`) so the collector is fully
 * unit-testable without touching the network. The collector never writes to D1
 * except for cursors, never calls the AI and never normalizes.
 */

import type { Env } from "../env";
import { loadConfig } from "../lib/config";
import { getCursor, setCursor } from "../lib/db";
import { createLogger } from "../lib/logger";
import { HttpError, isRetryableStatus, withRetry } from "../lib/retry";
import type { Collector, RawPost } from "../types";
import { cursorKey } from "./types";

/** Observable dependencies, injectable for tests. */
export interface CollectorIo {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const OAUTH_BASE = "https://oauth.reddit.com";
const MAX_POSTS_PER_REQUEST = 100;
const THROTTLE_MS = 1_000;
const RETRIES = 3;

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

/** A Reddit post as stored in a listing, already narrowed from `unknown`. */
interface RedditPostData {
  fullname: string;
  permalink: string;
  url: string;
  title: string;
  selftext: string;
  author: string;
  createdUtc: number;
  stickied: boolean;
}

function parsePostData(record: Record<string, unknown>): RedditPostData {
  const id = readString(record, "id");
  return {
    fullname: readString(record, "name") || (id === "" ? "" : `t3_${id}`),
    permalink: readString(record, "permalink"),
    url: readString(record, "url"),
    title: readString(record, "title"),
    selftext: readString(record, "selftext"),
    author: readString(record, "author"),
    createdUtc: readNumber(record, "created_utc"),
    stickied: record["stickied"] === true,
  };
}

/** Extracts the posts of a Reddit listing payload; ignores unknown shapes. */
function parseListing(payload: unknown): RedditPostData[] {
  const root = asRecord(payload);
  const data = root ? asRecord(root.data) : null;
  const children = data ? data.children : undefined;
  if (!Array.isArray(children)) return [];

  const posts: RedditPostData[] = [];
  for (const child of children) {
    const childRecord = asRecord(child);
    const postRecord = childRecord ? asRecord(childRecord.data) : null;
    if (postRecord) posts.push(parsePostData(postRecord));
  }
  return posts;
}

function extractAccessToken(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  const token = record.access_token;
  return typeof token === "string" && token !== "" ? token : null;
}

/** Cursor stored per subreddit: newest post seen by the previous run. */
interface RedditCursor {
  id: string;
  createdAt: number;
}

function decodeCursor(raw: string | null): RedditCursor | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = asRecord(parsed);
    if (!record) return null;
    const createdAt = readNumber(record, "lastCreatedUtc");
    const fullname = readString(record, "lastFullname");
    if (fullname === "" && createdAt === 0) return null;
    return { id: fullname, createdAt };
  } catch {
    // Corrupted cursor: treat as absent so the next run simply re-reads the listing.
    return null;
  }
}

/** True when `candidate` is strictly newer than `reference`. */
function isNewer(candidate: RedditCursor, reference: RedditCursor): boolean {
  if (candidate.createdAt !== reference.createdAt) return candidate.createdAt > reference.createdAt;
  return candidate.id > reference.id;
}

/** Posts that carry no usable identity/URL cannot be stored idempotently. */
function toRawPost(post: RedditPostData): RawPost | null {
  if (post.fullname === "") return null;
  const url = post.permalink ? `https://www.reddit.com${post.permalink}` : post.url;
  if (url === "") return null;
  const content = post.selftext.trim() === "" ? post.title : post.selftext;
  if (content.trim() === "") return null;
  return {
    id: post.fullname,
    externalId: post.fullname,
    source: "reddit",
    url,
    title: post.title,
    content,
    author: post.author,
    createdAt: post.createdUtc * 1000,
  };
}

function shouldSkip(post: RedditPostData): boolean {
  const isRemovedText = (value: string): boolean => value === "[removed]" || value === "[deleted]";
  if (post.stickied) return true;
  if (post.author === "" || isRemovedText(post.author)) return true;
  if (isRemovedText(post.selftext.trim())) return true;
  return false;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text();
    throw new HttpError(response.status, body);
  }
  return (await response.json()) as unknown;
}

export function createRedditCollector(options: CollectorIo = {}): Collector<Env> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const logger = createLogger("collector.reddit");

  const retryOptions = {
    retries: RETRIES,
    sleep,
    // Only 429/5xx (and 408/409/425) are worth retrying; auth/404 never are.
    isRetryable: (error: unknown): boolean => error instanceof HttpError && isRetryableStatus(error.status),
  };

  return {
    source: "reddit",

    async collect(env: Env): Promise<RawPost[]> {
      const config = loadConfig(env);
      const { clientId, clientSecret, userAgent, subreddits, postsPerSubreddit } = config.reddit;

      if (clientId === "" || clientSecret === "") {
        logger.warn("reddit.credentials_missing", {
          hint: "set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to enable the Reddit collector",
        });
        return [];
      }

      const limit = Math.min(Math.max(1, Math.floor(postsPerSubreddit)), MAX_POSTS_PER_REQUEST);

      // Sequential requests, one second apart, to stay well inside Reddit's
      // rate limits. The first request of the run is not delayed.
      let requested = false;
      const throttle = async (): Promise<void> => {
        if (requested) await sleep(THROTTLE_MS);
        requested = true;
      };

      const token = await fetchAccessToken();
      if (token === null) {
        logger.warn("reddit.token_failed", { hint: "could not obtain an OAuth access token for this run" });
        return [];
      }

      const collected: RawPost[] = [];
      const now = Date.now();

      for (const subreddit of subreddits) {
        try {
          const posts = await collectSubreddit(subreddit);
          collected.push(...posts);
        } catch (error) {
          // One broken subreddit must not abort the others.
          logger.warn("reddit.subreddit_failed", {
            subreddit,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info("reddit.collected", { subreddits: subreddits.length, posts: collected.length });
      return collected;

      async function fetchAccessToken(): Promise<string | null> {
        try {
          await throttle();
          const payload = await withRetry(
            async () =>
              parseJsonResponse(
                await fetchImpl(TOKEN_URL, {
                  method: "POST",
                  headers: {
                    Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": userAgent,
                  },
                  body: "grant_type=client_credentials",
                }),
              ),
            retryOptions,
          );
          const accessToken = extractAccessToken(payload);
          if (accessToken === null) logger.warn("reddit.token_missing_in_response");
          return accessToken;
        } catch (error) {
          logger.warn("reddit.token_request_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }

      async function collectSubreddit(subreddit: string): Promise<RawPost[]> {
        const key = cursorKey("reddit", subreddit);
        const cursor = decodeCursor(await getCursor(env.DB, key));

        await throttle();
        const payload = await withRetry(
          async () =>
            parseJsonResponse(
              await fetchImpl(
                `${OAUTH_BASE}/r/${encodeURIComponent(subreddit)}/new?limit=${limit}&raw_json=1`,
                {
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "User-Agent": userAgent,
                  },
                },
              ),
            ),
          retryOptions,
        );

        const listing = parseListing(payload);

        let newest: RedditCursor | null = null;
        for (const post of listing) {
          if (post.fullname === "") continue;
          const candidate: RedditCursor = { id: post.fullname, createdAt: post.createdUtc };
          if (newest === null || isNewer(candidate, newest)) newest = candidate;
        }

        const fresh = listing
          .filter((post) => !shouldSkip(post))
          .filter(
            (post) =>
              post.fullname !== "" &&
              (cursor === null || isNewer({ id: post.fullname, createdAt: post.createdUtc }, cursor)),
          )
          .map(toRawPost)
          .filter((post): post is RawPost => post !== null);

        // Advance only after the listing succeeded, and only forward: a listing
        // that returns no new posts must not roll the cursor backwards.
        if (newest !== null && (cursor === null || isNewer(newest, cursor))) {
          await setCursor(
            env.DB,
            key,
            JSON.stringify({ lastFullname: newest.id, lastCreatedUtc: newest.createdAt }),
            now,
          );
        }

        logger.debug("reddit.subreddit_done", {
          subreddit,
          seen: listing.length,
          emitted: fresh.length,
        });
        return fresh;
      }
    },
  };
}
