import type { Cursor, CursorSource } from './cursor';

/**
 * How a table is read at a past instant.
 * - appendOnly: rows are never changed; keep rows stamped before the instant.
 * - existence: rows change in place; keep rows created before it (their
 *   current values may be newer, which the host accepts).
 * - passthrough: not time-bound (configuration, reference data).
 * - derived: rebuilt from other tables at read time.
 */
export type TemporalStrategy = 'appendOnly' | 'existence' | 'passthrough' | 'derived';

export type TemporalRegistry = Readonly<Record<string, TemporalStrategy>>;

/** The runtime's own tables. The log and its summaries are append-only, so as-of history reads are exact. */
export const HISTORY_TABLES: TemporalRegistry = {
  activities: 'appendOnly',
  blocks: 'appendOnly',
  memories: 'existence',
};

/**
 * A past instant every read is bounded by: rows stamped strictly before it.
 * `at` is for display and clocks; `cursor` is what stores compare. The trigger
 * that woke a replayed run is fetched by id without this bound, so the
 * boundary row is never ambiguous.
 *
 * A block (leaf or merged) is visible as of the instant only when it was
 * written before it as well as ended before it: a summary written later is
 * knowledge the reader did not have then, even over a stretch that had ended.
 * Where a block was not yet written, a read falls back to the finer blocks
 * that were, down to raw entries.
 */
export interface AsOf {
  at: number;
  cursor: Cursor;
  registry: TemporalRegistry;
}

export function asOfAt(store: CursorSource, at: number, registry: TemporalRegistry = HISTORY_TABLES): AsOf {
  return { at, cursor: store.cursorAt(at), registry };
}
