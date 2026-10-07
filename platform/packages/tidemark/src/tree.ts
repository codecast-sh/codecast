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

/**
 * Tile [lo,hi) with aligned power-of-two blocks, keeping a block whole iff it
 * lies inside the range and its size is at most `alpha` times its age (the
 * distance from its start to hi). Bigger alpha: coarser, fewer lines. With
 * lo = 0 the root is the smallest power of two holding [0,hi), which is the
 * original cover.
 */
function coverAt(lo: number, hi: number, alpha: number): Array<[number, number]> {
  let root = 1;
  while (Math.floor(lo / root) !== Math.floor((hi - 1) / root)) root *= 2;
  const start = Math.floor(lo / root) * root;
  const out: Array<[number, number]> = [];
  const stack: Array<[number, number]> = [[start, start + root]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (a >= hi || b <= lo) continue;
    const size = b - a;
    if (size > 1 && (b > hi || a < lo || size > alpha * (hi - a))) {
      const mid = (a + b) / 2;
      stack.push([mid, b], [a, mid]);
    } else {
      out.push([a, b]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** The smallest alpha in (lo, hi] whose cover fits the budget, by bisection. */
function fitAlpha(lo: number, hi: number, from: number, to: number, budget: number): number {
  for (let i = 0; i < 60; i++) {
    const mid = (from + to) / 2;
    if (coverAt(lo, hi, mid).length > budget) from = mid;
    else to = mid;
  }
  return to;
}

/**
 * The blocks a reader renders over leaves [lo, hi): at most `budget` of them,
 * oldest first, finest near hi. When everything fits, every leaf renders
 * verbatim. A span that cannot be tiled in `budget` aligned blocks (budget
 * below its minimal aligned tiling, at most about 2·log2 of its length)
 * returns that minimal tiling; callers compare the length with the budget.
 */
export function coverSpan(lo: number, hi: number, budget: number): TreeBlock[] {
  const n = hi - lo;
  if (n <= 0 || budget <= 0 || lo < 0) return [];
  if (n <= budget) {
    return Array.from({ length: n }, (_, i) => ({ level: 0, index: lo + i }));
  }
  let out = coverAt(lo, hi, fitAlpha(lo, hi, 0, 1, budget));
  // Size at most age (alpha 1) can still be too fine for a small budget; only
  // then are blocks allowed to outgrow their age, up to the minimal tiling.
  if (out.length > budget) out = coverAt(lo, hi, fitAlpha(lo, hi, 1, n, budget));
  // Block sizes jump in powers of two, so alpha alone can undershoot the
  // budget. Spend what is left on the present, where detail is worth most.
  while (out.length < budget) {
    let at = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i][1] - out[i][0] > 1) {
        at = i;
        break;
      }
    }
    if (at < 0) break;
    const [a, b] = out[at];
    const mid = (a + b) / 2;
    out.splice(at, 1, [a, mid], [mid, b]);
  }
  return out.map(([a, b]) => blockOf(a, b));
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
