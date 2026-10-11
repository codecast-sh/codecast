/**
 * The merge tree over a scope's compressed history, after OptMem
 * (github.com/VictorTaelin/OptMem, `memo`).
 *
 * A scope's leaves (level 0 blocks, each a summary of raw activities) are
 * numbered 0..T-1 in time order. A BLOCK is an aligned power-of-two run of
 * leaves: level L block k covers leaves [k*2^L, (k+1)*2^L) and is the summary
 * of its two children, (L-1, 2k) and (L-1, 2k+1). Position is identity, so
 * every block has exactly one slot and a duplicate cannot exist. Merged blocks
 * are a cache: any of them can be dropped and rebuilt from the level below.
 *
 * The reader renders a cover: the leaves tiled by blocks whose size grows with
 * age, so recent history stays verbatim, older history comes as coarser
 * blocks, the line count is fixed, and the beginning is never dropped.
 *
 * Everything here is pure; compress.ts builds the blocks and history.ts
 * renders them.
 */

export interface TreeBlock {
  level: number;
  index: number;
}

/** The leaves a block covers, [lo, hi). */
export function blockSpan(b: TreeBlock): [number, number] {
  const size = 2 ** b.level;
  return [b.index * size, (b.index + 1) * size];
}

function blockOf(lo: number, hi: number): TreeBlock {
  const size = hi - lo;
  return { level: Math.log2(size), index: lo / size };
}

export function blockKey(b: TreeBlock): string {
  return `${b.level}:${b.index}`;
}

/** The two halves of a merged block. */
export function blockChildren(b: TreeBlock): [TreeBlock, TreeBlock] {
  return [
    { level: b.level - 1, index: 2 * b.index },
    { level: b.level - 1, index: 2 * b.index + 1 },
  ];
}

/** The block one level up that contains this one. */
export function blockParent(b: TreeBlock): TreeBlock {
  return { level: b.level + 1, index: Math.floor(b.index / 2) };
}

/** The other half of this block's parent. */
export function blockSibling(b: TreeBlock): TreeBlock {
  return { level: b.level, index: b.index ^ 1 };
}

/** The fewest aligned power-of-two blocks that tile [lo, hi), oldest first. */
function minimalTiling(lo: number, hi: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = lo; at < hi; ) {
    let size = 1;
    while (at % (size * 2) === 0 && at + size * 2 <= hi) size *= 2;
    out.push([at, at + size]);
    at += size;
  }
  return out;
}

/**
 * The blocks a reader renders over leaves [lo, hi): at most `budget` of them,
 * oldest first, finest near hi. When everything fits, every leaf renders
 * verbatim. A span that cannot be tiled in `budget` aligned blocks (budget
 * below its minimal aligned tiling, at most about 2·log2 of its length)
 * returns that minimal tiling; callers compare the length with the budget.
 *
 * Which blocks merge: starting from the leaves, the most due pair of sibling
 * blocks merges into its parent, again and again, until the budget is met. A
 * pair at level l whose last leaf is `last` is due by (hi - last) / 2^l: how
 * long ago it ended, in its own size. Ties go to the oldest pair. Measured
 * from a pair's end, old blocks stay put as the span grows and the churn sits
 * at the recent end; with the budget at its length, this is exactly the list
 * Taelin's rollback `push` keeps (UniiChat, "Taelin's rollback push").
 *
 * A parent pair is always less due than its children (at most half as due),
 * so the merges come out in one global order, by level from finest: each
 * level merges a prefix of its blocks, oldest first. That is what is computed
 * here, one merge at a time, in O((hi - lo) · log) without simulating pairs.
 */
export function coverSpan(lo: number, hi: number, budget: number): TreeBlock[] {
  const n = hi - lo;
  if (n <= 0 || budget <= 0 || lo < 0) return [];
  // Per level from 1: the merged blocks there are indices [first, next).
  const levels: Array<{ size: number; first: number; next: number; end: number }> = [];
  for (let size = 2; size <= n; size *= 2) {
    const first = Math.ceil(lo / size);
    const end = Math.floor(hi / size);
    if (first < end) levels.push({ size, first, next: first, end });
  }
  for (let left = n - Math.floor(budget); left > 0; left--) {
    let pick: (typeof levels)[number] | undefined;
    let pickDue = -1;
    for (const l of levels) {
      if (l.next >= l.end) continue;
      // The pair under block l.next: its last leaf, in units of its own size.
      const due = (hi - ((l.next + 1) * l.size - 1)) / (l.size / 2);
      if (due > pickDue || (due === pickDue && l.next * l.size < pick!.next * pick!.size)) {
        pick = l;
        pickDue = due;
      }
    }
    if (!pick) break;
    pick.next++;
  }
  const merged = (a: number, size: number) => {
    const l = levels[Math.log2(size) - 1];
    return a / size < l.next;
  };
  const out: TreeBlock[] = [];
  const emit = (a: number, b: number) => {
    if (b - a === 1 || merged(a, b - a)) out.push(blockOf(a, b));
    else {
      emit(a, (a + b) / 2);
      emit((a + b) / 2, b);
    }
  };
  for (const [a, b] of minimalTiling(lo, hi)) emit(a, b);
  return out;
}

/** The cover over T leaves: coverSpan(0, T, budget). */
export function cover(T: number, budget: number): TreeBlock[] {
  return coverSpan(0, T, budget);
}

/**
 * Resolve wanted blocks against what exists: a block that exists is kept, a
 * merged block that does not is replaced by its two halves, recursively.
 * Leaves are returned as asked; the caller renders what it has. The span is
 * never narrowed, so a reader can always render a cover, whatever merges are
 * missing.
 */
export function resolveBlocks(wanted: readonly TreeBlock[], exists: (b: TreeBlock) => boolean): TreeBlock[] {
  const out: TreeBlock[] = [];
  const visit = (b: TreeBlock) => {
    if (b.level === 0 || exists(b)) {
      out.push(b);
      return;
    }
    for (const c of blockChildren(b)) visit(c);
  };
  for (const b of wanted) visit(b);
  return out;
}

/**
 * The merges a cover over T leaves needs and does not have, smallest first,
 * so every block is listed after both of its children. Blocks under a cover
 * block are needed to build it; nothing outside the cover's merged blocks is
 * ever listed.
 */
export function pendingMerges(T: number, budget: number, exists: (b: TreeBlock) => boolean): TreeBlock[] {
  const todo: TreeBlock[] = [];
  const visit = (b: TreeBlock) => {
    if (b.level === 0 || exists(b)) return;
    for (const c of blockChildren(b)) visit(c);
    todo.push(b);
  };
  for (const b of cover(T, budget)) visit(b);
  return todo.sort((a, b) => a.level - b.level || a.index - b.index);
}

/**
 * Every merge buildable over T leaves that does not exist yet, smallest first:
 * each aligned block that lies wholly inside [0, T). With all of them built,
 * any budget and any stretch renders at its asked resolution; there are fewer
 * than T of them in total, so a growing scope costs under one merge per leaf.
 */
export function completeMerges(T: number, exists: (b: TreeBlock) => boolean): TreeBlock[] {
  const todo: TreeBlock[] = [];
  for (let level = 1; 2 ** level <= T; level++) {
    for (let index = 0; (index + 1) * 2 ** level <= T; index++) {
      const b = { level, index };
      if (!exists(b)) todo.push(b);
    }
  }
  return todo;
}

/**
 * The default line budget of a scoped read's compressed history. A scope with
 * this many leaves or fewer renders every leaf verbatim; a longer one renders
 * this many blocks reaching back to its first leaf.
 */
export const HISTORY_COVER_LINES = 32;

export interface TreeRow {
  level: number;
  /** Null or absent: a leaf not yet numbered. */
  blockIndex?: number | null;
  /** When the block's last activity happened, in ms (display precision is enough against a wall-clock boundary). */
  endMs: number;
}

/**
 * How many leaves a cover reads: those numbered before the first leaf that
 * ends at or after `boundaryMs`. Leaves are numbered in time order, so this is
 * the run of history that ended before the raw window begins. A missing leaf
 * number inside the run is counted and renders as nothing.
 */
export function leafPrefixCount(rows: readonly TreeRow[], boundaryMs: number): number {
  let firstOpen = Infinity;
  let top = -1;
  for (const r of rows) {
    if (r.level !== 0 || r.blockIndex == null) continue;
    top = Math.max(top, r.blockIndex);
    if (r.endMs >= boundaryMs) firstOpen = Math.min(firstOpen, r.blockIndex);
  }
  return Math.min(firstOpen, top + 1);
}

/**
 * The rows a reader renders, oldest first: cover(T, budget) over the leaves
 * that ended before `boundaryMs`, each missing merged block opened into its
 * halves. Rows outside the tree (unnumbered leaves) are ignored; a scope with
 * any unnumbered leaf is not read through here (see isNumberedScope).
 */
export function planCover<R extends TreeRow>(rows: readonly R[], boundaryMs: number, budget: number = HISTORY_COVER_LINES): R[] {
  const byKey = new Map<string, R>();
  for (const r of rows) {
    if (r.blockIndex == null) continue;
    byKey.set(blockKey({ level: r.level, index: r.blockIndex }), r);
  }
  const T = leafPrefixCount(rows, boundaryMs);
  const blocks = resolveBlocks(cover(T, budget), (b) => byKey.has(blockKey(b)));
  const out: R[] = [];
  for (const b of blocks) {
    const row = byKey.get(blockKey(b));
    if (row) out.push(row);
  }
  return out;
}

/** Whether a scope's leaves are all numbered, so its history reads as a tree. */
export function isNumberedScope(rows: readonly TreeRow[]): boolean {
  return rows.every((r) => r.level !== 0 || r.blockIndex != null);
}
