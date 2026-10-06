/**
 * Normalization: turns raw collector output into a stable, storable post.
 * Pure functions only — no I/O, fully unit testable.
 */

import { stableId } from "../lib/db";
import type { NormalizedPost, RawPost } from "../types";

export const MAX_CONTENT_CHARS = 4000;
export const MAX_TITLE_CHARS = 200;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  "#39": "'",
  "#x27": "'",
  "#x2F": "/",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const known = ENTITIES[entity];
    if (known !== undefined) return known;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

export function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

const TRACKING_PARAM_EXACT = new Set(["ref", "fbclid", "gclid", "mc_cid", "mc_eid", "igshid", "si", "s", "share_id"]);
const TRACKING_PARAM_PREFIXES = ["utm_", "mc_", "_ga", "pk_", "mtm_"];

/** Removes anchors and tracking params so the same discussion has one URL. */
export function canonicalizeUrl(url: string): string {
  const raw = url.trim();
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (TRACKING_PARAM_EXACT.has(lower) || TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hostname = parsed.hostname.replace(/^(www|m|old|amp|new)\./i, "");
    const search = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${search === "" ? "" : `?${search}`}`;
  } catch {
    return raw;
  }
}

export function normalizeRawPost(raw: RawPost, now: number): NormalizedPost {
  const cleaned = collapseWhitespace(decodeHtmlEntities(stripHtml(raw.content ?? "")));
  const title = raw.title === undefined || raw.title === null
    ? null
    : collapseWhitespace(stripHtml(raw.title)).slice(0, MAX_TITLE_CHARS) || null;

  const body = truncate(cleaned, MAX_CONTENT_CHARS);
  const content = body === "" && title !== null ? title : body;
  const createdAt =
    Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? Math.floor(raw.createdAt) : now;

  return {
    id: stableId(raw.source, raw.externalId),
    externalId: raw.externalId,
    source: raw.source,
    url: canonicalizeUrl(raw.url),
    title,
    content,
    author: raw.author ?? null,
    createdAt,
    fetchedAt: now,
  };
}

/** Normalizes a batch and deduplicates within the batch (same discussion twice). */
export function normalizeRawPosts(raws: readonly RawPost[], now: number): NormalizedPost[] {
  const seen = new Set<string>();
  const out: NormalizedPost[] = [];
  for (const raw of raws) {
    const normalized = normalizeRawPost(raw, now);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}
