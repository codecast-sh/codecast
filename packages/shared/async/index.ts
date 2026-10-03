// Async helpers shared by the CLI and the eval home.

/**
 * Bounded-concurrency map: at most `limit` calls of `fn` in flight, results
 * in input order. Work runs in parallel but never in a stampede. `until`
 * stops the pool early: once a result satisfies it, no further item starts
 * (calls already in flight finish), and the items never started stay holes.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  opts: { until?: (result: R) => boolean } = {},
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!stopped) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
      if (opts.until?.(out[i]!)) stopped = true;
    }
  });
  await Promise.all(workers);
  return out;
}
