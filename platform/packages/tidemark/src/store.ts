import type { AsOf } from './asof';
import type { Cursor, CursorSource } from './cursor';
import type { Activity, Block, NewActivity, NewLeaf } from './log';
import type { Partition, Scope, ScopeSelector, ScopeType } from './scope';
import type { TreeBlock } from './tree';

export interface ActivityQuery {
  /** Selectors arrive widened (storeSelector): `all.except` already holds every off-feed type. */
  select: ScopeSelector;
  partition: Partition;
  /** Strictly after this cursor. */
  after?: Cursor;
  /** At or after this cursor. */
  from?: Cursor;
  /** Strictly before this cursor. */
  before?: Cursor;
  /** At or before this cursor. */
  until?: Cursor;
  kinds?: readonly string[];
  order: 'asc' | 'desc';
  limit: number;
  /** Bounds every row by `asOf.cursor` (strictly before), on top of `before`. */
  asOf?: AsOf;
}

export interface TreeIndexRow {
  id: string;
  level: number;
  index: number | null;
  startMs: number;
  endMs: number;
}

export interface LeafTip {
  /** The newest leaf's end, exactly as stored: the next window starts strictly after it. */
  end: Cursor | null;
  lastIndex: number | null;
  /** Some leaf has no position yet (legacy data). */
  unnumbered: boolean;
}

/**
 * Where history lives. A scope's log is identified by (partition, scope); no
 * call ever returns a row from another partition. Every bound is a cursor the
 * store compares natively.
 */
export interface HistoryStore extends CursorSource {
  // log
  append(a: NewActivity): Promise<Activity>;
  activities(q: ActivityQuery): Promise<Activity[]>;
  /** One activity by id, or null (also null when it is not older than `asOf`). */
  activity(id: string, asOf?: AsOf): Promise<Activity | null>;
  /** Keyword search over summaries, newest first. Optional; the reader falls back to a bounded scan. */
  search?(q: { select: ScopeSelector; partition: Partition; text: string; limit: number; kinds?: readonly string[]; until?: Cursor; asOf?: AsOf }): Promise<Activity[]>;

  // compression (write side)
  /**
   * Scopes with at least `minCount` activities older than `olderThan` and
   * newer than the scope's newest leaf. Types in `skip` are never listed.
   */
  backlog(q: { olderThan: Cursor; minCount: number; skip: readonly ScopeType[] }): Promise<Array<{ scope: Scope; partition: Partition; count: number }>>;
  leafTip(scope: Scope, partition: Partition): Promise<LeafTip>;
  /**
   * Append a leaf at position lastIndex+1, only while the scope's last leaf
   * index is still `expectedLastIndex` and no leaf is unnumbered. Exactly one
   * of two racing appends lands. Returns the block, or null when refused.
   */
  appendLeaf(scope: Scope, partition: Partition, leaf: NewLeaf, expectedLastIndex: number | null): Promise<Block | null>;
  /**
   * Insert merged block `at` from its two children (by id), only while both
   * exist in this scope at their positions (level-1, 2i) and (level-1, 2i+1).
   * Bounds, count, kinds and tasks come from the children as stored. A second
   * copy of a slot is ignored (null).
   */
  putBlock(scope: Scope, partition: Partition, at: TreeBlock, content: string, left: string, right: string): Promise<Block | null>;
  /**
   * Legacy only: drop unnumbered leaves contained in another leaf (keeping the
   * longest, then the newest), then number the rest after the last numbered
   * leaf in time order. Atomic per scope.
   */
  numberLegacyLeaves?(scope: Scope, partition: Partition): Promise<{ dropped: number; numbered: number }>;
  /** Scopes with more than `minLeaves` numbered leaves that ended before `endedBefore`. */
  scopesNeedingMerges(q: { endedBefore: Cursor; minLeaves: number; skip: readonly ScopeType[] }): Promise<Array<{ scope: Scope; partition: Partition }>>;

  // tree (read side)
  /** Positions only, no content, of every block (those that ended before `endedBefore`, and that existed as of `asOf`, when given). */
  treeIndex(scope: Scope, partition: Partition, q: { endedBefore?: Cursor; asOf?: AsOf }): Promise<TreeIndexRow[]>;
  blocks(ids: readonly string[], asOf?: AsOf): Promise<Block[]>;
  block(id: string, asOf?: AsOf): Promise<Block | null>;
  /** The block at a position, or null. */
  blockAt(scope: Scope, partition: Partition, at: TreeBlock, asOf?: AsOf): Promise<Block | null>;
  /** Leaves newest first (by start). The feed and unnumbered scopes read these. */
  leaves(q: { select: ScopeSelector; partition: Partition; endedBefore: Cursor; limit: number; asOf?: AsOf }): Promise<Block[]>;
  /** The numbered leaf whose span holds this activity's cursor, or null. */
  leafHolding(a: Activity, asOf?: AsOf): Promise<Block | null>;
  /** Raw activities a leaf covers, oldest first. */
  activitiesIn(leaf: Block, asOf?: AsOf): Promise<Activity[]>;
}
