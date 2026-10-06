// What every product's sources need around a slow read: a read kept for a
// while, so a page's several asks share one, and the rows handed over as the
// same array until they change, which rowsMemo keys its answers by. Pure: a
// clock comes in, nothing here reads node or the DOM.

export interface KeptReadOptions {
  /** How long one answer serves. */
  maxAgeMs: number;
  /**
   * Past maxAgeMs, hand the last answer at once and read again behind it; a
   * failed read behind it keeps the last answer. Without it a caller past
   * maxAgeMs waits for the new read, and a failed read is not kept.
   */
  staleWhileRevalidate?: boolean;
  now?: () => number;
}

/**
 * A read kept in memory. Callers within maxAgeMs of the last answer share it,
 * and callers while a read is in flight share that read. A read that fails is
 * never kept: the next caller reads again.
 */
export function keptRead<T>(read: () => Promise<T>, o: KeptReadOptions): () => Promise<T> {
  const now = o.now ?? Date.now;
  let last: { at: number; value: T } | null = null;
  let pending: Promise<T> | null = null;
  const start = (): Promise<T> =>
    (pending ??= read()
      .then((value) => {
        last = { at: now(), value };
        return value;
      })
      .finally(() => {
        pending = null;
      }));
  return () => {
    if (last && now() - last.at < o.maxAgeMs) return Promise.resolve(last.value);
    if (last && o.staleWhileRevalidate) {
      void start().catch(() => null);
      return Promise.resolve(last.value);
    }
    return start();
  };
}

/**
 * Rows read afresh, handed back as the last array while their signature holds
 * (EvalsSources.rows: "the same array until the rows change"), so the
 * handler's answers for that array are kept. The signature defaults to the
 * rows as JSON; a product with a cheaper one (a version stamp) passes it.
 */
export function stableRows<R>(sig: (rows: readonly R[]) => string = (rows) => JSON.stringify(rows)): (rows: R[]) => R[] {
  let last: { sig: string; rows: R[] } | null = null;
  return (rows) => {
    const s = sig(rows);
    if (last?.sig !== s) last = { sig: s, rows };
    return last.rows;
  };
}
