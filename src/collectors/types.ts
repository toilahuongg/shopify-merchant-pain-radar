/**
 * Collector contract shared by every source.
 *
 * Adding X/Facebook later = implement `Collector` + register it in
 * src/collectors/index.ts. Normalization, rule filtering, queueing, AI and
 * storage are source agnostic.
 */

export type { Collector, RawPost } from "../types";

/**
 * Cursor naming convention: `reddit:shopify`, `shopify:community`.
 * Kept in one place so every collector stores cursors identically.
 */
export function cursorKey(...parts: string[]): string {
  return parts
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter((part) => part !== "")
    .join(":");
}

/** Posts fetched per collector run, logged for observability. */
export interface CollectorRunStats {
  source: string;
  fetched: number;
  errors: number;
}
