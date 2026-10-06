/**
 * Collector registry.
 *
 * `runIngest` only knows about this list; adding a source = add a file here.
 */

import type { Env } from "../env";
import type { Collector } from "../types";
import { createRedditCollector } from "./reddit";
import { createShopifyCollector } from "./shopify";

export type { CollectorIo } from "./reddit";

/** All enabled collectors, in run order. */
export function getCollectors(): Collector<Env>[] {
  return [createRedditCollector(), createShopifyCollector()];
}
