// Pixel layout of one grid axis (rows or columns): a default size with sparse
// overrides (resized columns, hidden rows at 0), answered in O(log n) through
// sorted prefix sums. Offsets are 1-based index -> px from the start of the
// axis.

export class AxisLayout {
  readonly count: number;
  readonly def: number;
  private idx: number[]; // sorted indices with a custom size
  private size: number[]; // their sizes
  private deltaBefore: number[]; // sum of (size - def) for custom indices strictly before idx[k]
  readonly total: number;

  constructor(count: number, def: number, custom: Map<number, number>) {
    this.count = count;
    this.def = def;
    const entries = [...custom.entries()].filter(([i]) => i >= 1 && i <= count).sort((a, b) => a[0] - b[0]);
    this.idx = entries.map((e) => e[0]);
    this.size = entries.map((e) => Math.max(0, e[1]));
    this.deltaBefore = [];
    let acc = 0;
    for (let k = 0; k < entries.length; k++) {
      this.deltaBefore.push(acc);
      acc += this.size[k] - def;
    }
    this.total = count * def + acc;
  }

  /** Index of the first custom entry >= i. */
  private lower(i: number): number {
    let lo = 0, hi = this.idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.idx[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  sizeOf(i: number): number {
    const k = this.lower(i);
    return this.idx[k] === i ? this.size[k] : this.def;
  }

  /** px where index i starts. offset(count + 1) === total. */
  offset(i: number): number {
    const k = this.lower(i);
    const delta = k < this.idx.length ? this.deltaBefore[k] : this.deltaBefore.length ? this.deltaBefore[this.deltaBefore.length - 1] + this.size[this.size.length - 1] - this.def : 0;
    return (i - 1) * this.def + delta;
  }

  /** The index whose span holds px (clamped to 1..count). Zero-size indices are skipped. */
  indexAt(px: number): number {
    if (px <= 0) return this.firstVisible(1);
    if (px >= this.total) return this.count;
    let lo = 1, hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offset(mid) <= px) lo = mid;
      else hi = mid - 1;
    }
    return this.firstVisible(lo);
  }

  private firstVisible(i: number): number {
    let j = i;
    while (j < this.count && this.sizeOf(j) === 0) j++;
    return j;
  }

  /** Indices overlapping [from, to) px, inclusive range. */
  span(from: number, to: number): [number, number] {
    return [this.indexAt(from), this.indexAt(Math.max(from, to - 1))];
  }

  /** The next index after i that is not hidden (size > 0), or i when none. */
  step(i: number, dir: 1 | -1): number {
    let j = i + dir;
    while (j >= 1 && j <= this.count && this.sizeOf(j) === 0) j += dir;
    return j < 1 || j > this.count ? i : j;
  }
}
