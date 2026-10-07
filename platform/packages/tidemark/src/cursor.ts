/**
 * A cursor is a store-native exact time, comparable only as the store
 * compares it. It is never parsed into a JS Date for comparison: a Date keeps
 * milliseconds, a Postgres timestamp keeps microseconds, and a bound read back
 * through a Date sits just before the row it came from, so the next window
 * re-reads that row forever. Core code only passes cursors back to the store
 * that minted them, and tests them for equality.
 */
export type Cursor = string & { readonly __cursor: unique symbol };

/** Brand a string the store minted. Only stores call this. */
export const asCursor = (s: string): Cursor => s as Cursor;

/** What core needs from a store to bound a read by wall time. */
export interface CursorSource {
  /**
   * The cursor of an instant: rows stamped at or after `ms` compare greater
   * or equal, rows stamped before it compare less. A strict `before: cursorAt(ms)`
   * keeps exactly the rows older than `ms`.
   */
  cursorAt(ms: number): Cursor;
}
