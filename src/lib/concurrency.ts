/**
 * Bounded-concurrency map. Used for AI calls, collector fan-out and Telegram
 * sends — never fire unbounded parallel requests from a Worker.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const effectiveLimit = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: effectiveLimit }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

/** Splits an array into chunks of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunkSize = Math.max(1, size);
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    out.push(items.slice(index, index + chunkSize));
  }
  return out;
}
