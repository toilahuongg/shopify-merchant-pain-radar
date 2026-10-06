import { describe, expect, it, vi } from "vitest";
import { createRedditCollector } from "../src/collectors/reddit";
import { createShopifyCollector } from "../src/collectors/shopify";
import type { Env } from "../src/env";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Minimal D1 stub covering `getCursor`/`setCursor` from src/lib/db.ts. */
interface FakeDb {
  db: D1Database;
  cursors: Map<string, string>;
}

function fakeDb(): FakeDb {
  const cursors = new Map<string, string>();

  function prepare(sql: string): D1PreparedStatement {
    const statement = {
      bind(...args: unknown[]) {
        return {
          async first<T>(): Promise<T | null> {
            if (sql.includes("FROM source_cursors")) {
              const value = cursors.get(String(args[0]));
              return value === undefined ? null : ({ cursor: value } as unknown as T);
            }
            return null;
          },
          async run() {
            if (sql.includes("INTO source_cursors")) {
              cursors.set(String(args[0]), String(args[1]));
            }
            return { success: true };
          },
        };
      },
    };
    return statement as unknown as D1PreparedStatement;
  }

  return { db: { prepare } as unknown as D1Database, cursors };
}

/** Env shaped object containing only what `loadConfig` and the collectors read. */
function envWith(db: D1Database, overrides: Record<string, string> = {}): Env {
  return { DB: db, ...overrides } as unknown as Env;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function fetchMock(handler: FetchHandler) {
  const mock = vi.fn(handler);
  return { mock, fetchImpl: mock as unknown as typeof fetch };
}

const neverSleep = async (): Promise<void> => {};

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_AUTH: Record<string, string> = {
  REDDIT_CLIENT_ID: "client-id",
  REDDIT_CLIENT_SECRET: "client-secret",
  REDDIT_USER_AGENT: "merchant-signal-test/1.0",
  SUBREDDITS: "shopify",
  REDDIT_POSTS_PER_SUBREDDIT: "10",
};

// --- Reddit fixtures --------------------------------------------------------

interface RedditPostFixture {
  name: string;
  id: string;
  permalink: string;
  url: string;
  title: string;
  selftext: string;
  author: string;
  created_utc: number;
  stickied: boolean;
}

function redditPost(overrides: Partial<RedditPostFixture> = {}): RedditPostFixture {
  return {
    name: "t3_abc",
    id: "abc",
    permalink: "/r/shopify/comments/abc/help_with_checkout/",
    url: "https://example.com/thread",
    title: "Help with checkout",
    selftext: "Checkout fails on mobile.",
    author: "alice",
    created_utc: 1_700_000_000,
    stickied: false,
    ...overrides,
  };
}

function redditListing(posts: readonly RedditPostFixture[]) {
  return { kind: "Listing", data: { children: posts.map((data) => ({ kind: "t3", data })) } };
}

// --- Shopify fixtures -------------------------------------------------------

interface ShopifyTopicFixture {
  id: number;
  title: string;
  slug: string;
  created_at: string;
}

function shopifyTopic(overrides: Partial<ShopifyTopicFixture> = {}): ShopifyTopicFixture {
  return {
    id: 101,
    title: "Checkout broken on mobile",
    slug: "topic-a",
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function shopifyListing(topics: readonly ShopifyTopicFixture[]) {
  return { topic_list: { topics } };
}

function shopifyDetail(author: string, cooked: string) {
  return { post_stream: { posts: [{ username: author, cooked }] } };
}

const SHOPIFY_ENV: Record<string, string> = { SHOPIFY_COMMUNITY_PAGES: "1" };
const SHOPIFY_CURSOR_KEY = "shopify:community";

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------

describe("createRedditCollector", () => {
  it("resolves to [] with no HTTP call when credentials are missing", async () => {
    const { db } = fakeDb();
    const { mock: handler, fetchImpl } = fetchMock(async (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createRedditCollector({ fetchImpl, sleep: neverSleep });

    await expect(collector.collect(envWith(db, { SUBREDDITS: "shopify" }))).resolves.toEqual([]);
    await expect(
      collector.collect(envWith(db, { ...REDDIT_AUTH, REDDIT_CLIENT_SECRET: "" })),
    ).resolves.toEqual([]);
    await expect(
      collector.collect(envWith(db, { ...REDDIT_AUTH, REDDIT_CLIENT_ID: "" })),
    ).resolves.toEqual([]);

    expect(handler).not.toHaveBeenCalled();
  });

  it("maps listing posts to RawPost after obtaining a token", async () => {
    const { db } = fakeDb();
    const main = redditPost();
    const titleOnly = redditPost({
      name: "t3_def",
      id: "def",
      permalink: "/r/shopify/comments/def/no_selftext/",
      url: "https://example.com/def",
      title: "No selftext here",
      selftext: "",
      author: "bob",
      created_utc: 1_700_000_050,
    });
    const { mock: handler, fetchImpl } = fetchMock(async (url) => {
      if (url === REDDIT_TOKEN_URL) return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://oauth.reddit.com/r/shopify/new")) {
        return jsonResponse(redditListing([main, titleOnly]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createRedditCollector({ fetchImpl, sleep: neverSleep });

    const posts = await collector.collect(envWith(db, REDDIT_AUTH));

    expect(handler.mock.calls[0]?.[0]).toBe(REDDIT_TOKEN_URL);
    expect(handler.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(handler.mock.calls[1]?.[0]).toBe(
      "https://oauth.reddit.com/r/shopify/new?limit=10&raw_json=1",
    );
    expect(posts).toEqual([
      {
        id: "t3_abc",
        externalId: "t3_abc",
        source: "reddit",
        url: "https://www.reddit.com/r/shopify/comments/abc/help_with_checkout/",
        title: "Help with checkout",
        content: "Checkout fails on mobile.",
        author: "alice",
        createdAt: 1_700_000_000_000,
      },
      {
        id: "t3_def",
        externalId: "t3_def",
        source: "reddit",
        url: "https://www.reddit.com/r/shopify/comments/def/no_selftext/",
        title: "No selftext here",
        content: "No selftext here",
        author: "bob",
        createdAt: 1_700_000_050_000,
      },
    ]);
  });

  it("skips stickied posts and removed/deleted authors", async () => {
    const { db } = fakeDb();
    const listing = redditListing([
      redditPost({ name: "t3_keep", id: "keep" }),
      redditPost({ name: "t3_sticky", id: "sticky", stickied: true }),
      redditPost({ name: "t3_deleted", id: "deleted", author: "[deleted]" }),
      redditPost({ name: "t3_removed_author", id: "ra", author: "[removed]" }),
      redditPost({ name: "t3_removed_body", id: "rb", selftext: "[removed]" }),
      redditPost({ name: "t3_no_author", id: "na", author: "" }),
    ]);
    const { fetchImpl } = fetchMock(async (url) => {
      if (url === REDDIT_TOKEN_URL) return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://oauth.reddit.com/r/shopify/new")) return jsonResponse(listing);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createRedditCollector({ fetchImpl, sleep: neverSleep });

    const posts = await collector.collect(envWith(db, REDDIT_AUTH));

    expect(posts.map((post) => post.externalId)).toEqual(["t3_keep"]);
  });

  it("emits each post once across repeated runs and persists the cursor", async () => {
    const { db, cursors } = fakeDb();
    const older = redditPost({ name: "t3_old", id: "old", created_utc: 1_700_000_000 });
    const newer = redditPost({ name: "t3_new", id: "new", created_utc: 1_700_000_100 });
    const { fetchImpl } = fetchMock(async (url) => {
      if (url === REDDIT_TOKEN_URL) return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://oauth.reddit.com/r/shopify/new")) {
        return jsonResponse(redditListing([older, newer]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createRedditCollector({ fetchImpl, sleep: neverSleep });
    const env = envWith(db, REDDIT_AUTH);

    const first = await collector.collect(env);
    const second = await collector.collect(env);

    expect(first.map((post) => post.externalId)).toEqual(["t3_old", "t3_new"]);
    expect(second).toEqual([]);

    const raw: unknown = JSON.parse(cursors.get("reddit:shopify") as string);
    expect(raw).toEqual({ lastFullname: "t3_new", lastCreatedUtc: 1_700_000_100 });
  });

  it("isolates one failing subreddit from the others", async () => {
    const { db } = fakeDb();
    const { mock: handler, fetchImpl } = fetchMock(async (url) => {
      if (url === REDDIT_TOKEN_URL) return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://oauth.reddit.com/r/good/new")) {
        return jsonResponse(redditListing([redditPost({ name: "t3_good", id: "good" })]));
      }
      if (url.startsWith("https://oauth.reddit.com/r/bad/new")) {
        return jsonResponse({ error: "boom" }, 500);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createRedditCollector({ fetchImpl, sleep: neverSleep });

    const posts = await collector.collect(
      envWith(db, { ...REDDIT_AUTH, SUBREDDITS: "good,bad" }),
    );

    expect(posts.map((post) => post.externalId)).toEqual(["t3_good"]);
    expect(handler.mock.calls.some(([url]) => url.includes("/r/bad/new"))).toBe(true);
  });

  it("retries a 429 on the listing and succeeds", async () => {
    const { db } = fakeDb();
    let listingAttempts = 0;
    const { mock: handler, fetchImpl } = fetchMock(async (url) => {
      if (url === REDDIT_TOKEN_URL) return jsonResponse({ access_token: "tok" });
      if (url.includes("/new")) {
        listingAttempts += 1;
        if (listingAttempts === 1) return jsonResponse({ error: "rate limited" }, 429);
        return jsonResponse(redditListing([redditPost()]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createRedditCollector({ fetchImpl, sleep: neverSleep });

    const posts = await collector.collect(envWith(db, REDDIT_AUTH));

    expect(posts.map((post) => post.externalId)).toEqual(["t3_abc"]);
    expect(listingAttempts).toBe(2);
    expect(handler.mock.calls.filter(([url]) => url.includes("/new"))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

describe("createShopifyCollector", () => {
  it("hydrates topics newer than the cursor and maps them to RawPost", async () => {
    const { db } = fakeDb();
    const topic = shopifyTopic();
    const { mock: handler, fetchImpl } = fetchMock(async (url) => {
      if (url.includes("/latest.json")) return jsonResponse(shopifyListing([topic]));
      if (url === "https://community.shopify.com/t/101.json") {
        return jsonResponse(shopifyDetail("bob", "<p>Hello</p>"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createShopifyCollector({ fetchImpl, sleep: neverSleep });

    const posts = await collector.collect(envWith(db, SHOPIFY_ENV));

    expect(posts).toEqual([
      {
        id: "101",
        externalId: "101",
        source: "shopify",
        url: "https://community.shopify.com/t/topic-a/101",
        title: "Checkout broken on mobile",
        content: "Checkout broken on mobile\n\n<p>Hello</p>",
        author: "bob",
        createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
      },
    ]);
    expect(handler.mock.calls.filter(([url]) => /\/t\/\d+\.json$/.test(url))).toHaveLength(1);
  });

  it("emits nothing on a second run once the cursor advanced", async () => {
    const { db } = fakeDb();
    const topic = shopifyTopic();
    const { mock: handler, fetchImpl } = fetchMock(async (url) => {
      if (url.includes("/latest.json")) return jsonResponse(shopifyListing([topic]));
      if (url === "https://community.shopify.com/t/101.json") {
        return jsonResponse(shopifyDetail("bob", "<p>Hello</p>"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createShopifyCollector({ fetchImpl, sleep: neverSleep });
    const env = envWith(db, SHOPIFY_ENV);

    const first = await collector.collect(env);
    const second = await collector.collect(env);

    expect(first.map((post) => post.externalId)).toEqual(["101"]);
    expect(second).toEqual([]);
    expect(handler.mock.calls.filter(([url]) => /\/t\/\d+\.json$/.test(url))).toHaveLength(1);
  });

  it("resolves with what it has on a listing bot challenge and keeps the cursor", async () => {
    const { db, cursors } = fakeDb();
    const existing = JSON.stringify({ lastCreatedAt: 1_000, lastTopicId: 7 });
    cursors.set(SHOPIFY_CURSOR_KEY, existing);
    const { mock: handler, fetchImpl } = fetchMock(async (url) => {
      if (url.includes("/latest.json")) return textResponse("<html>challenge</html>", 403);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createShopifyCollector({ fetchImpl, sleep: neverSleep });

    const posts = await collector.collect(envWith(db, SHOPIFY_ENV));

    expect(posts).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(cursors.get(SHOPIFY_CURSOR_KEY)).toBe(existing);
  });

  it("does not advance the cursor past a topic whose detail fetch failed", async () => {
    const { db, cursors } = fakeDb();
    const topicA = shopifyTopic({
      id: 201,
      slug: "a",
      title: "Topic A",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    const topicB = shopifyTopic({
      id: 202,
      slug: "b",
      title: "Topic B",
      created_at: "2024-01-02T00:00:00.000Z",
    });
    const { fetchImpl } = fetchMock(async (url) => {
      if (url.includes("/latest.json")) return jsonResponse(shopifyListing([topicB, topicA]));
      if (url === "https://community.shopify.com/t/201.json") {
        return jsonResponse(shopifyDetail("alice", "<p>first</p>"));
      }
      if (url === "https://community.shopify.com/t/202.json") {
        return jsonResponse({ error: "boom" }, 500);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collector = createShopifyCollector({ fetchImpl, sleep: neverSleep });

    const posts = await collector.collect(envWith(db, SHOPIFY_ENV));

    expect(posts.map((post) => post.externalId)).toEqual(["201"]);
    const raw: unknown = JSON.parse(cursors.get(SHOPIFY_CURSOR_KEY) as string);
    expect(raw).toEqual({
      lastCreatedAt: Date.parse("2024-01-01T00:00:00.000Z"),
      lastTopicId: 201,
    });
  });
});
