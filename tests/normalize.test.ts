import { describe, expect, it } from "vitest";
import { stableId } from "../src/lib/db";
import {
  MAX_CONTENT_CHARS,
  canonicalizeUrl,
  collapseWhitespace,
  decodeHtmlEntities,
  normalizeRawPost,
  normalizeRawPosts,
  stripHtml,
  truncate,
} from "../src/processing/normalize";
import type { RawPost } from "../src/types";

const NOW = 1_700_000_000_000;

function raw(overrides: Partial<RawPost> = {}): RawPost {
  return {
    id: "ignored",
    externalId: "abc123",
    source: "reddit",
    url: "https://www.reddit.com/r/shopify/comments/abc123/title/?utm_source=share&utm_medium=web#comment",
    title: "Inventory mismatch",
    content: "Stock is wrong again",
    author: "merchant1",
    createdAt: 1_699_000_000_000,
    ...overrides,
  };
}

describe("stableId", () => {
  it("is deterministic and source scoped", () => {
    expect(stableId("reddit", "abc")).toBe(stableId("reddit", "abc"));
    expect(stableId("reddit", "abc")).not.toBe(stableId("shopify", "abc"));
  });

  it("is case insensitive on the source", () => {
    expect(stableId("REDDIT", "abc")).toBe(stableId("reddit", "abc"));
  });
});

describe("html helpers", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry &#39;quote&#39; &lt;b&gt;")).toBe(
      "Tom & Jerry 'quote' <b>",
    );
  });

  it("strips scripts, styles and tags but keeps line breaks", () => {
    const html = "<div>Hello<script>evil()</script><style>.a{}</style><br>World</p>";
    const stripped = stripHtml(html);
    expect(stripped).not.toContain("evil()");
    expect(stripped).not.toContain(".a{}");
    expect(stripped).toContain("Hello");
    expect(stripped).toContain("World");
  });

  it("collapses whitespace and blank lines", () => {
    expect(collapseWhitespace("a   b\n\n\n\nc  ")).toBe("a b\n\nc");
  });

  it("truncates with an ellipsis marker", () => {
    const result = truncate("x".repeat(50), 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("canonicalizeUrl", () => {
  it("drops tracking params, hash, www and trailing slash", () => {
    expect(
      canonicalizeUrl(
        "https://www.reddit.com/r/shopify/comments/abc123/title/?utm_source=share&utm_medium=web&ref=feed#comment",
      ),
    ).toBe("https://reddit.com/r/shopify/comments/abc123/title");
  });

  it("keeps meaningful query params", () => {
    expect(canonicalizeUrl("https://community.shopify.com/t/topic/123?page=2")).toBe(
      "https://community.shopify.com/t/topic/123?page=2",
    );
  });

  it("returns the trimmed input when the url is invalid", () => {
    expect(canonicalizeUrl("  not a url  ")).toBe("not a url");
  });
});

describe("normalizeRawPost", () => {
  it("produces a deterministic id from source and external id", () => {
    const first = normalizeRawPost(raw(), NOW);
    const second = normalizeRawPost(raw({ id: "something-else" }), NOW);
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(stableId("reddit", "abc123"));
  });

  it("falls back to now when createdAt is missing and to title when content is empty", () => {
    const post = normalizeRawPost(raw({ createdAt: 0, content: "   " }), NOW);
    expect(post.createdAt).toBe(NOW);
    expect(post.content).toBe("Inventory mismatch");
  });

  it("truncates long content", () => {
    const post = normalizeRawPost(raw({ content: "a".repeat(MAX_CONTENT_CHARS * 2) }), NOW);
    expect(post.content.length).toBe(MAX_CONTENT_CHARS);
  });

  it("canonicalizes the url and strips html", () => {
    const post = normalizeRawPost(
      raw({ content: "<p>widgets &amp; gadgets</p>", url: "https://www.reddit.com/r/shopify/comments/abc123/t/?utm_source=x" }),
      NOW,
    );
    expect(post.url).toBe("https://reddit.com/r/shopify/comments/abc123/t");
    expect(post.content).toBe("widgets & gadgets");
  });
});

describe("normalizeRawPosts deduplication", () => {
  it("deduplicates the same discussion appearing twice in one batch", () => {
    const posts = normalizeRawPosts(
      [raw(), raw({ url: "https://reddit.com/r/shopify/comments/abc123/t" }), raw({ externalId: "other" })],
      NOW,
    );
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((post) => post.id)).size).toBe(2);
  });
});
