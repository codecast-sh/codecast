// The recalculation engine. A Workbook holds every tab's cell inputs, parses
// formulas once, tracks which cells each formula reads (single cells and
// ranges), and evaluates lazily: a read evaluates the cell's precedents first
// in an explicit-stack DFS (so a 10k-row chain cannot overflow the call
// stack), caches every result, and an edit clears the cache of exactly the
// cells downstream of it. A cycle marks every cell on it #CIRC!.
import { FUNCTIONS, type FnContext } from "./functions";
import { ARRAY_FUNCTIONS } from "./arrayFunctions";
import { scalarOf } from "./functionArgs";
import { FormulaSyntaxError, MAX_COL, MAX_ROW, isFormula, parseFormula, type Node } from "./formula";
import {
  compareScalars,
  err,
  isError,
  isGrid,
  parseLiteral,
  scalarsEqual,
  toNumber,
  toText,
  type ImpliedFormat,
  type SheetError,
  type Scalar,
  type Value,
} from "./values";
import { a1, parseQualifiedRange, type Rect } from "./refs";

export type TabInfo = { id: string; name: string };

type RangeDep = { ti: number; c0: number; r0: number; c1: number; r1: number };

type Entry = {
  input: string;
  ti: number;
  col: number;
  row: number;
  /** Formula cells: the AST, or a syntax error message. */
  ast?: Node;
  syntax?: string;
  /** Precedents resolved against the current tab names. */
  points?: number[];
  ranges?: RangeDep[];
  /** Literal cells: the parsed value and implied format. */
  literal?: Scalar;
  implied?: ImpliedFormat;
  /** Formula cells: 0 stale, 1 evaluating, 2 cached. */
  state: 0 | 1 | 2;
  value?: Scalar;
};

const COL_BITS = 2 ** 15; // > MAX_COL
const ROW_BITS = 2 ** 20; // > MAX_ROW

function cid(ti: number, col: number, row: number): number {
  return (ti * ROW_BITS + row) * COL_BITS + col;
}

function decode(id: number): { ti: number; col: number; row: number } {
  const ti = Math.floor(id / COL_BITS / ROW_BITS);
  const rest = id - ti * ROW_BITS * COL_BITS;
  const row = Math.floor(rest / COL_BITS);
  return { ti, row, col: rest - row * COL_BITS };
}

export type CellInfo = {
  input: string;
  value: Scalar;
  implied?: ImpliedFormat;
  formula: boolean;
  /** A value spilled here by an array formula elsewhere (FILTER, UNIQUE, ...); the cell itself holds no input. */
  spilled?: boolean;
};

/** Where an array formula's block sits: its anchor cell and the rectangle (grid null while cells are in the way). */
type Spill = { ti: number; c0: number; r0: number; c1: number; r1: number; grid: Scalar[][] | null };

function sameScalar(a: Scalar | undefined, b: Scalar | undefined): boolean {
  if (isError(a) || isError(b)) return isError(a) && isError(b) && a.error === b.error;
  return a === b;
}

/** Changes above this size re-dirty every formula instead of walking dependents. */
const BULK_THRESHOLD = 256;
/** An invalidation walk that has dirtied this many cells marks every formula stale instead. */
const DIRTY_ALL_AFTER = 4_000;
const DIRTY_ALL_WORK = 250_000;
const ADDRESS_ONLY = new Set(["ROW", "COLUMN", "ROWS", "COLUMNS"]);
const VOLATILE = new Set(["TODAY", "NOW"]);
/** Functions whose cells are found while evaluating (OFFSET, INDIRECT): they recalculate after every change, as in Excel. */
const DYNAMIC = new Set(["OFFSET", "INDIRECT"]);

export class Workbook {
  private entries = new Map<number, Entry>();
  private tabIndex = new Map<string, number>();
  private tabIds: string[] = [];
  private nameToId = new Map<string, string>();
  private idToName = new Map<string, string>();
  private formulasByTab = new Map<number, Set<number>>();
  private extents = new Map<number, { rows: number; cols: number }>();
  /** precedent cell -> formula cells that read it directly. */
  private pointDeps = new Map<number, Set<number>>();
  /** formula cell -> ranges it reads. */
  private rangeDeps = new Map<number, RangeDep[]>();
  /** Range readers bucketed by (tab, column) for ranges a few columns wide; wider ones in a per-tab list. */
  private rangeByCol = new Map<number, Set<number>>();
  private rangeWide = new Map<number, Set<number>>();
  /** Formulas that read the clock (TODAY, NOW). */
  private volatile = new Set<number>();
  private dynamic = new Set<number>();
  /** LET's names while its body evaluates, innermost last. */
  private scopes: Array<Map<string, Value>> = [];
  /** Array formulas (outermost function FILTER, UNIQUE, SORT, ...): their block spills into the cells beside them. */
  private anchors = new Set<number>();
  private spills = new Map<number, Spill>();
  /** Spilled cell -> the anchor whose block covers it. */
  private spillOf = new Map<number, number>();
  /** Cells whose spilled value changed during an evaluation; their readers are invalidated once it ends. */
  private spillMoved: number[] = [];
  /** Anchors whose block changed: formulas reading it whole (E1#) re-run. */
  private spillTouched = new Set<number>();
  private now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  private ti(tabId: string): number {
    let i = this.tabIndex.get(tabId);
    if (i === undefined) {
      i = this.tabIds.length;
      this.tabIds.push(tabId);
      this.tabIndex.set(tabId, i);
    }
    return i;
  }

  /** Replace the tab list (ids and names). Names resolve cross-tab references. */
  setTabs(tabs: TabInfo[]): void {
    const before = [...this.nameToId.entries()].sort().join("|");
    this.nameToId.clear();
    this.idToName.clear();
    for (const t of tabs) {
      this.nameToId.set(t.name.toLowerCase(), t.id);
      this.idToName.set(t.id, t.name);
      this.ti(t.id);
    }
    const after = [...this.nameToId.entries()].sort().join("|");
    if (before === after) return;
    // Names moved: every formula's precedents re-resolve.
    for (const [id, e] of this.entries) if (e.ast) this.linkDeps(id, e);
    this.dirtyAll();
    this.settle();
  }

  tabName(tabId: string): string | undefined {
    return this.idToName.get(tabId);
  }

  tabIdForName(name: string): string | undefined {
    return this.nameToId.get(name.toLowerCase());
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /** Set (or clear, with null/"") many cells; recalculation is lazy. */
  update(changes: Array<{ tab: string; col: number; row: number; input: string | null }>): void {
    const changed: number[] = [];
    for (const ch of changes) {
      const id = this.write(ch.tab, ch.col, ch.row, ch.input);
      if (id !== null) changed.push(id);
    }
    if (changed.length === 0) return;
    // A write inside an array formula's block (or where a blocked one wants to go) makes it place again.
    if (this.spills.size) {
      const anchors = new Set<number>();
      for (const id of changed) {
        const a = this.spillOf.get(id);
        if (a !== undefined) anchors.add(a);
      }
      for (const [a, sp] of this.spills) {
        if (sp.grid) continue;
        for (const id of changed) {
          const { ti, col, row } = decode(id);
          if (id !== a && ti === sp.ti && col >= sp.c0 && col <= sp.c1 && row >= sp.r0 && row <= sp.r1) anchors.add(a);
        }
      }
      for (const a of anchors) if (this.entries.has(a)) changed.push(a);
    }
    // OFFSET and INDIRECT read cells nobody can know ahead: they run again after any change.
    for (const d of this.dynamic) if (this.entries.has(d)) changed.push(d);
    if (changed.length > BULK_THRESHOLD) this.dirtyAll();
    else this.invalidate(changed);
    this.settle();
  }

  /**
   * Place every stale array formula's block, then invalidate the readers of
   * cells whose spilled value changed; repeat while blocks move (an array
   * formula can read another's block).
   */
  private settle(): void {
    for (let pass = 0; pass < 8; pass++) {
      for (const a of this.anchors) {
        const e = this.entries.get(a);
        if (e && e.state === 0) this.ensure(a);
      }
      if (!this.spillMoved.length) return;
      const moved = this.spillMoved;
      for (const a of this.spillTouched) for (const d of this.pointDeps.get(a) ?? []) if (d !== a) moved.push(d);
      this.spillMoved = [];
      this.spillTouched.clear();
      this.invalidate(moved);
    }
  }

  /** Take an anchor's block off the grid, noting the cells that lose a value. */
  private unspill(anchor: number, keep?: Spill): void {
    const sp = this.spills.get(anchor);
    if (!sp) return;
    this.spills.delete(anchor);
    if (!sp.grid) return;
    for (let r = sp.r0; r <= sp.r1; r++)
      for (let c = sp.c0; c <= sp.c1; c++) {
        const id = cid(sp.ti, c, r);
        if (id === anchor || this.spillOf.get(id) !== anchor) continue;
        this.spillOf.delete(id);
        const stays = keep?.grid && r <= keep.r1 && c <= keep.c1 && sameScalar(keep.grid[r - keep.r0]?.[c - keep.c0] ?? null, sp.grid[r - sp.r0]?.[c - sp.c0] ?? null);
        if (!stays) {
          this.spillMoved.push(id);
          this.spillTouched.add(anchor);
        }
      }
  }

  /** An array formula's result: its block goes into the empty cells beside it, or #SPILL! when something is in the way. */
  private place(id: number, e: Entry, v: Value): Scalar {
    const grid = isGrid(v) && (v.grid.length > 1 || (v.grid[0]?.length ?? 0) > 1) ? v.grid : null;
    if (!grid) {
      this.unspill(id);
      return topLevel(v);
    }
    const r1 = Math.min(MAX_ROW, e.row + grid.length - 1);
    const c1 = Math.min(MAX_COL, e.col + Math.max(...grid.map((r) => r.length)) - 1);
    let blocked: { c: number; r: number } | null = null;
    for (let r = e.row; r <= r1 && !blocked; r++)
      for (let c = e.col; c <= c1; c++) {
        const cell = cid(e.ti, c, r);
        if (cell === id) continue;
        const owner = this.spillOf.get(cell);
        if (this.entries.has(cell) || (owner !== undefined && owner !== id)) {
          blocked = { c, r };
          break;
        }
      }
    const next: Spill = { ti: e.ti, c0: e.col, r0: e.row, c1, r1, grid: blocked ? null : grid };
    this.unspill(id, next);
    this.spills.set(id, next);
    if (blocked) return err("#SPILL!", `${a1(blocked.c, blocked.r)} is in the way of ${a1(e.col, e.row)}:${a1(c1, r1)}`);
    for (let r = e.row; r <= r1; r++)
      for (let c = e.col; c <= c1; c++) {
        const cell = cid(e.ti, c, r);
        if (cell === id || this.spillOf.get(cell) === id) continue;
        this.spillOf.set(cell, id);
        this.spillMoved.push(cell);
        this.spillTouched.add(id);
      }
    const ext = this.extents.get(e.ti) ?? { rows: 0, cols: 0 };
    if (r1 > ext.rows || c1 > ext.cols) this.extents.set(e.ti, { rows: Math.max(ext.rows, r1), cols: Math.max(ext.cols, c1) });
    return topLevel(grid[0][0] ?? null);
  }

  /** The block an array formula fills (its anchor's address), when it spills. */
  spillRange(tab: string, col: number, row: number): Rect | null {
    const ti = this.tabIndex.get(tab);
    if (ti === undefined) return null;
    const sp = this.spills.get(cid(ti, col, row));
    return sp?.grid ? { c0: sp.c0, r0: sp.r0, c1: sp.c1, r1: sp.r1 } : null;
  }

  /** The array formula a spilled cell's value comes from (its anchor's address), or null. */
  spillAnchor(tab: string, col: number, row: number): { col: number; row: number } | null {
    const ti = this.tabIndex.get(tab);
    if (ti === undefined) return null;
    const a = this.spillOf.get(cid(ti, col, row));
    if (a === undefined) return null;
    const { col: c, row: r } = decode(a);
    return { col: c, row: r };
  }

  /** Every block spilling on a tab, for drawing the cells that hold no input. */
  spillRects(tab: string): Rect[] {
    const ti = this.tabIndex.get(tab);
    const out: Rect[] = [];
    if (ti === undefined) return out;
    for (const sp of this.spills.values()) if (sp.ti === ti && sp.grid) out.push({ c0: sp.c0, r0: sp.r0, c1: sp.c1, r1: sp.r1 });
    return out;
  }

  setCell(tab: string, col: number, row: number, input: string | null): void {
    this.update([{ tab, col, row, input }]);
  }

  private write(tab: string, col: number, row: number, input: string | null): number | null {
    // Outside the grid nothing is stored (ids pack row and column into fixed bits).
    if (row < 1 || col < 1 || row > MAX_ROW || col > MAX_COL) return null;
    const ti = this.ti(tab);
    const id = cid(ti, col, row);
    const prev = this.entries.get(id);
    const text = input ?? "";
    if ((prev?.input ?? "") === text) return null;
    if (prev?.ast || prev?.syntax) this.unlinkDeps(id, prev);
    if (this.anchors.has(id)) {
      this.anchors.delete(id);
      this.unspill(id);
    }
    if (text === "") {
      this.entries.delete(id);
      this.formulasByTab.get(ti)?.delete(id);
      return id;
    }
    const e: Entry = { input: text, ti, col, row, state: 0 };
    if (isFormula(text)) {
      try {
        e.ast = parseFormula(text.slice(1));
      } catch (x) {
        e.syntax = x instanceof FormulaSyntaxError ? x.message : String(x);
      }
      let set = this.formulasByTab.get(ti);
      if (!set) this.formulasByTab.set(ti, (set = new Set()));
      set.add(id);
      if (e.ast) this.linkDeps(id, e);
      if (e.ast?.t === "fn" && ARRAY_FUNCTIONS.has(e.ast.name)) this.anchors.add(id);
    } else {
      this.formulasByTab.get(ti)?.delete(id);
      const lit = parseLiteral(text);
      e.literal = lit.value;
      e.implied = lit.implied;
      e.state = 2;
    }
    this.entries.set(id, e);
    const ext = this.extents.get(ti) ?? { rows: 0, cols: 0 };
    if (row > ext.rows || col > ext.cols) this.extents.set(ti, { rows: Math.max(ext.rows, row), cols: Math.max(ext.cols, col) });
    return id;
  }

  private resolveTab(name: string | undefined, selfTi: number): number | null {
    if (name === undefined) return selfTi;
    const id = this.nameToId.get(name.toLowerCase());
    return id === undefined ? null : this.ti(id);
  }

  private linkDeps(id: number, e: Entry): void {
    this.unlinkDeps(id, e);
    const points: number[] = [];
    const ranges: RangeDep[] = [];
    const walk = (n: Node) => {
      switch (n.t) {
        case "ref": {
          const ti = this.resolveTab(n.tab, e.ti);
          if (ti !== null) points.push(cid(ti, n.col, n.row));
          return;
        }
        case "range": {
          const ti = this.resolveTab(n.tab, e.ti);
          if (ti !== null) ranges.push({ ti, c0: n.c0, r0: n.r0, c1: n.c1, r1: n.r1 });
          return;
        }
        case "spill": {
          // E1#: depends on the anchor; its block moving re-runs readers (settle).
          const ti = this.resolveTab(n.tab, e.ti);
          if (ti !== null) points.push(cid(ti, n.col, n.row));
          return;
        }
        case "fn":
          // ROW(A1), COLUMN(A1), ROWS(A1:A9), COLUMNS(...) read an address, not a value.
          if (ADDRESS_ONLY.has(n.name)) {
            for (const a of n.args) if (a.t !== "ref" && a.t !== "range") walk(a);
            return;
          }
          if (VOLATILE.has(n.name)) volatile = true;
          if (DYNAMIC.has(n.name)) dynamic = true;
          n.args.forEach(walk);
          return;
        case "neg":
        case "pct":
          walk(n.a);
          return;
        case "bin":
          walk(n.a);
          walk(n.b);
          return;
      }
    };
    let volatile = false;
    let dynamic = false;
    walk(e.ast!);
    if (volatile) this.volatile.add(id);
    else this.volatile.delete(id);
    if (dynamic) this.dynamic.add(id);
    else this.dynamic.delete(id);
    e.points = points;
    e.ranges = ranges;
    for (const p of points) {
      let s = this.pointDeps.get(p);
      if (!s) this.pointDeps.set(p, (s = new Set()));
      s.add(id);
    }
    if (ranges.length) {
      this.rangeDeps.set(id, ranges);
      for (const r of ranges) for (const b of this.bucketsOf(r)) {
        const map = b.wide ? this.rangeWide : this.rangeByCol;
        let set = map.get(b.key);
        if (!set) map.set(b.key, (set = new Set()));
        set.add(id);
      }
    }
  }

  private bucketsOf(r: RangeDep): Array<{ wide: boolean; key: number }> {
    if (r.c1 - r.c0 > 16) return [{ wide: true, key: r.ti }];
    const out = [];
    for (let c = r.c0; c <= r.c1; c++) out.push({ wide: false, key: r.ti * COL_BITS + c });
    return out;
  }

  private unlinkDeps(id: number, e: Entry): void {
    for (const p of e.points ?? []) {
      const s = this.pointDeps.get(p);
      if (s) {
        s.delete(id);
        if (s.size === 0) this.pointDeps.delete(p);
      }
    }
    for (const r of this.rangeDeps.get(id) ?? []) for (const b of this.bucketsOf(r)) (b.wide ? this.rangeWide : this.rangeByCol).get(b.key)?.delete(id);
    this.rangeDeps.delete(id);
    this.volatile.delete(id);
    this.dynamic.delete(id);
    e.points = undefined;
    e.ranges = undefined;
  }

  private dirtyAll(): void {
    for (const e of this.entries.values()) {
      if (e.ast || e.syntax) {
        e.state = 0;
        e.value = undefined;
      }
    }
  }

  /** Mark everything downstream of the changed cells stale. */
  private invalidate(changed: number[]): void {
    const queue = [...changed];
    const seen = new Set<number>(changed);
    for (const id of changed) {
      const e = this.entries.get(id);
      if (e && (e.ast || e.syntax)) {
        e.state = 0;
        e.value = undefined;
      }
    }
    let work = 0;
    while (queue.length) {
      const id = queue.pop()!;
      const ti = Math.floor(id / COL_BITS / ROW_BITS);
      const rest = id - ti * ROW_BITS * COL_BITS;
      const row = Math.floor(rest / COL_BITS);
      const col = rest - row * COL_BITS;
      const hit = (dep: number) => {
        if (seen.has(dep)) return;
        seen.add(dep);
        const de = this.entries.get(dep);
        if (de) {
          de.state = 0;
          de.value = undefined;
        }
        queue.push(dep);
      };
      const direct = this.pointDeps.get(id);
      if (direct) for (const d of direct) hit(d);
      const scan = (set: Set<number> | undefined) => {
        if (!set) return;
        work += set.size;
        for (const dep of set) {
          if (seen.has(dep)) continue;
          for (const r of this.rangeDeps.get(dep) ?? []) {
            if (r.ti === ti && col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1) {
              hit(dep);
              break;
            }
          }
        }
      };
      scan(this.rangeByCol.get(ti * COL_BITS + col));
      scan(this.rangeWide.get(ti));
      // A change that reaches most of the sheet is cheaper to treat as everything.
      if (seen.size > DIRTY_ALL_AFTER || work > DIRTY_ALL_WORK) {
        this.dirtyAll();
        return;
      }
    }
  }

  /** The clock moved: formulas that read it, and everything downstream, recalculate on next read. */
  refreshVolatile(): boolean {
    if (this.volatile.size === 0) return false;
    this.invalidate([...this.volatile]);
    this.settle();
    return true;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The evaluated value of a cell. */
  value(tab: string, col: number, row: number): Scalar {
    const ti = this.tabIndex.get(tab);
    if (ti === undefined) return null;
    return this.valueById(cid(ti, col, row));
  }

  cell(tab: string, col: number, row: number): CellInfo | null {
    const ti = this.tabIndex.get(tab);
    if (ti === undefined) return null;
    const id = cid(ti, col, row);
    const e = this.entries.get(id);
    if (!e) return this.spillOf.has(id) ? { input: "", value: this.valueById(id), formula: false, spilled: true } : null;
    const formula = !!(e.ast || e.syntax);
    return { input: e.input, value: this.valueById(id), implied: e.implied, formula };
  }

  /** The used extent of a tab: last row and column holding input. */
  extent(tab: string): { rows: number; cols: number } {
    const ti = this.tabIndex.get(tab);
    return (ti !== undefined && this.extents.get(ti)) || { rows: 0, cols: 0 };
  }

  /** Evaluated values of a rectangle, rows[r][c]. */
  read(tab: string, rect: Rect): Scalar[][] {
    const ti = this.tabIndex.get(tab);
    if (ti === undefined) return [];
    return this.readGrid(ti, rect.c0, rect.r0, rect.c1, rect.r1);
  }

  /** Evaluate formula text as if it sat in a cell, without storing it. */
  evaluate(tab: string, col: number, row: number, formula: string): Scalar {
    const ti = this.ti(tab);
    let ast: Node;
    try {
      ast = parseFormula(formula.replace(/^=/, ""));
    } catch (x) {
      return err("#ERROR!", x instanceof Error ? x.message : String(x));
    }
    return topLevel(this.evalNode(ast, ti, { col, row, now: this.now() }));
  }

  private valueById(id: number): Scalar {
    const e = this.entries.get(id);
    if (!e) {
      const a = this.spillOf.get(id);
      if (a === undefined) return null;
      const ae = this.entries.get(a);
      if (ae && ae.state === 0) this.ensure(a);
      const sp = this.spills.get(a);
      if (!sp?.grid) return null;
      const { col, row } = decode(id);
      return sp.grid[row - sp.r0]?.[col - sp.c0] ?? null;
    }
    if (e.state === 2) return e.ast || e.syntax ? (e.value ?? null) : (e.literal ?? null);
    if (e.state === 1) return err("#CIRC!", "circular reference");
    this.ensure(id);
    return e.value ?? null;
  }

  private precedents(e: Entry): number[] {
    const out = e.points ? [...e.points] : [];
    for (const r of e.ranges ?? []) {
      const set = this.formulasByTab.get(r.ti);
      if (!set || set.size === 0) continue;
      const area = (r.c1 - r.c0 + 1) * (Math.min(r.r1, this.extents.get(r.ti)?.rows ?? 0) - r.r0 + 1);
      if (area > 0 && area < set.size) {
        const rows = Math.min(r.r1, this.extents.get(r.ti)?.rows ?? 0);
        const cols = Math.min(r.c1, this.extents.get(r.ti)?.cols ?? 0);
        for (let row = r.r0; row <= rows; row++)
          for (let col = r.c0; col <= cols; col++) {
            const id = cid(r.ti, col, row);
            if (set.has(id)) out.push(id);
          }
      } else {
        for (const id of set) {
          const fe = this.entries.get(id)!;
          if (fe.col >= r.c0 && fe.col <= r.c1 && fe.row >= r.r0 && fe.row <= r.r1) out.push(id);
        }
      }
    }
    return out;
  }

  /** Evaluate a formula cell and every stale formula it reads, deepest first. */
  private ensure(root: number): void {
    const rootEntry = this.entries.get(root)!;
    rootEntry.state = 1;
    const stack: Array<{ id: number; i: number; pre: number[] }> = [{ id: root, i: 0, pre: this.precedents(rootEntry) }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i < top.pre.length) {
        const p = top.pre[top.i++];
        const pe = this.entries.get(p);
        if (!pe || !(pe.ast || pe.syntax) || pe.state === 2) continue;
        if (pe.state === 1) {
          // p is on the stack: every frame from p to the top is on the cycle.
          let k = stack.length - 1;
          while (k >= 0 && stack[k].id !== p) k--;
          for (let j = Math.max(k, 0); j < stack.length; j++) {
            const ce = this.entries.get(stack[j].id)!;
            ce.value = err("#CIRC!", "circular reference");
            ce.state = 2;
          }
          continue;
        }
        pe.state = 1;
        stack.push({ id: p, i: 0, pre: this.precedents(pe) });
        continue;
      }
      stack.pop();
      const e = this.entries.get(top.id)!;
      if (e.state === 2) continue;
      e.value = this.compute(top.id, e);
      e.state = 2;
    }
  }

  private compute(id: number, e: Entry): Scalar {
    if (e.syntax) return err("#ERROR!", e.syntax);
    const v = this.evalNode(e.ast!, e.ti, { col: e.col, row: e.row, now: this.now() });
    return this.anchors.has(id) ? this.place(id, e, v) : topLevel(v);
  }

  private readGrid(ti: number, c0: number, r0: number, c1: number, r1: number): Scalar[][] {
    const ext = this.extents.get(ti) ?? { rows: 0, cols: 0 };
    // Whole columns/rows clip to the used area; a bounded range keeps its shape.
    const rows = r1 >= MAX_ROW ? Math.max(ext.rows, r0) : r1;
    const cols = c1 >= MAX_COL ? Math.max(ext.cols, c0) : c1;
    const out: Scalar[][] = [];
    for (let r = r0; r <= rows; r++) {
      const line: Scalar[] = [];
      for (let c = c0; c <= cols; c++) line.push(this.valueById(cid(ti, c, r)));
      out.push(line);
    }
    return out;
  }

  /** LET(name1, value1, [name2, value2, ...], calculation): each name holds its value while the rest evaluates. */
  private evalLet(args: Node[], ti: number, ctx: FnContext): Value {
    if (args.length < 3 || args.length % 2 === 0) return err("#N/A", "LET takes name, value pairs and then a calculation");
    const frame = new Map<string, Value>();
    this.scopes.push(frame);
    try {
      for (let i = 0; i < args.length - 1; i += 2) {
        const name = args[i];
        if (name.t !== "name") return err("#NAME?", "LET's names are words like price or total");
        frame.set(name.v.toLowerCase(), this.evalNode(args[i + 1], ti, ctx));
      }
      return this.evalNode(args[args.length - 1], ti, ctx);
    } finally {
      this.scopes.pop();
    }
  }

  /** OFFSET(reference, rows, cols, [height], [width]) and INDIRECT(text): a reference worked out while evaluating, read like one typed. */
  private evalReference(name: "OFFSET" | "INDIRECT", args: Node[], ti: number, ctx: FnContext): Value {
    let t: number | null;
    let rect: { c0: number; r0: number; c1: number; r1: number };
    if (name === "INDIRECT") {
      if (args.length < 1 || args.length > 2) return err("#N/A", "INDIRECT takes a reference as text");
      const text = toText(scalarOf(this.evalNode(args[0], ti, ctx)));
      if (isError(text)) return text;
      const q = parseQualifiedRange(text.replace(/\$/g, ""));
      if (!q) return err("#REF!", `"${text}" is not a reference`);
      t = this.resolveTab(q.tab, ti);
      if (t === null) return err("#REF!", `no tab named ${q.tab}`);
      rect = q.rect;
    } else {
      if (args.length < 3 || args.length > 5) return err("#N/A", "OFFSET takes a reference, rows, columns and an optional height and width");
      const base = args[0];
      if (base.t !== "ref" && base.t !== "range") return err("#VALUE!", "OFFSET starts from a cell or range");
      t = this.resolveTab(base.tab, ti);
      if (t === null) return err("#REF!", `no tab named ${base.tab}`);
      const b = base.t === "ref" ? { c0: base.col, r0: base.row, c1: base.col, r1: base.row } : base;
      const [dr, dc] = [intOf(this.evalNode(args[1], ti, ctx)), intOf(this.evalNode(args[2], ti, ctx))];
      const h = args[3] && args[3].t !== "empty" ? intOf(this.evalNode(args[3], ti, ctx)) : b.r1 - b.r0 + 1;
      const w = args[4] && args[4].t !== "empty" ? intOf(this.evalNode(args[4], ti, ctx)) : b.c1 - b.c0 + 1;
      for (const x of [dr, dc, h, w]) if (isError(x)) return x;
      if ((h as number) < 1 || (w as number) < 1) return err("#REF!", "OFFSET's height and width start at 1");
      rect = { r0: b.r0 + (dr as number), c0: b.c0 + (dc as number), r1: b.r0 + (dr as number) + (h as number) - 1, c1: b.c0 + (dc as number) + (w as number) - 1 };
    }
    if (rect.r0 < 1 || rect.c0 < 1) return err("#REF!", "the reference falls off the sheet");
    if (rect.r0 === rect.r1 && rect.c0 === rect.c1) return this.valueById(cid(t, rect.c0, rect.r0));
    return { grid: this.readGrid(t, rect.c0, rect.r0, rect.c1, rect.r1) };
  }

  private evalNode(n: Node, ti: number, ctx: FnContext): Value {
    switch (n.t) {
      case "num":
        return n.v;
      case "str":
        return n.v;
      case "bool":
        return n.v;
      case "err":
        return err(n.v);
      case "empty":
        return null;
      case "name": {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
          const v = this.scopes[i].get(n.v.toLowerCase());
          if (v !== undefined) return v;
        }
        return err("#NAME?", `unknown name ${n.v}`);
      }
      case "ref": {
        const t = this.resolveTab(n.tab, ti);
        if (t === null) return err("#REF!", `no tab named ${n.tab}`);
        return this.valueById(cid(t, n.col, n.row));
      }
      case "spill": {
        const t = this.resolveTab(n.tab, ti);
        if (t === null) return err("#REF!", `no tab named ${n.tab}`);
        const id = cid(t, n.col, n.row);
        const v = this.valueById(id);
        const sp = this.spills.get(id);
        return sp?.grid ? { grid: sp.grid } : this.anchors.has(id) ? v : err("#REF!", `${a1(n.col, n.row)} doesn't spill`);
      }
      case "array":
        return { grid: n.rows.map((r) => [...r]) };
      case "range": {
        const t = this.resolveTab(n.tab, ti);
        if (t === null) return err("#REF!", `no tab named ${n.tab}`);
        return { grid: this.readGrid(t, n.c0, n.r0, n.c1, n.r1) };
      }
      case "neg":
        return mapScalar(this.evalNode(n.a, ti, ctx), (v) => {
          const x = toNumber(v);
          return isError(x) ? x : -x;
        });
      case "pct":
        return mapScalar(this.evalNode(n.a, ti, ctx), (v) => {
          const x = toNumber(v);
          return isError(x) ? x : x / 100;
        });
      case "bin":
        return binary(n.op, this.evalNode(n.a, ti, ctx), this.evalNode(n.b, ti, ctx));
      case "fn": {
        if (n.name === "ROW" || n.name === "COLUMN") {
          const a = n.args[0];
          if (!a) return n.name === "ROW" ? ctx.row : ctx.col;
          if (a.t === "ref") return n.name === "ROW" ? a.row : a.col;
          if (a.t === "range") return n.name === "ROW" ? a.r0 : a.c0;
          return err("#VALUE!", `${n.name} takes a reference`);
        }
        if (n.name === "LET") return this.evalLet(n.args, ti, ctx);
        if (n.name === "OFFSET" || n.name === "INDIRECT") return this.evalReference(n.name, n.args, ti, ctx);
        if (n.name === "FORMULATEXT") {
          const a = n.args[0];
          if (a?.t !== "ref") return err("#N/A", "FORMULATEXT takes one cell");
          const t = this.resolveTab(a.tab, ti);
          const e = t === null ? undefined : this.entries.get(cid(t, a.col, a.row));
          return e && (e.ast || e.syntax) ? e.input : err("#N/A", `${a1(a.col, a.row)} has no formula`);
        }
        const def = FUNCTIONS[n.name];
        if (!def) return err("#NAME?", `unknown function ${n.name}`);
        if (n.args.length < def.min || (def.max !== undefined && n.args.length > def.max)) {
          const want = def.max === def.min ? `${def.min}` : def.max === undefined ? `at least ${def.min}` : `${def.min} to ${def.max}`;
          return err("#N/A", `${n.name} takes ${want} arguments, got ${n.args.length}`);
        }
        if (def.lazy) return def.lazy(n.args.map((a) => () => this.evalNode(a, ti, ctx)), ctx);
        return def.eager!(n.args.map((a) => this.evalNode(a, ti, ctx)), ctx);
      }
    }
  }
}

function intOf(v: Value): number | SheetError {
  const n = toNumber(scalarOf(v));
  return isError(n) ? n : Math.trunc(n);
}

function topLevel(v: Value): Scalar {
  const s = scalarOf(v);
  if (typeof s === "number" && !Number.isFinite(s)) return err("#NUM!");
  return s;
}

function mapScalar(v: Value, f: (s: Scalar) => Scalar): Value {
  if (isGrid(v)) return { grid: v.grid.map((r) => r.map(f)) };
  return f(v);
}

function binary(op: string, a: Value, b: Value): Value {
  if (isGrid(a) || isGrid(b)) {
    const ga = isGrid(a) ? a.grid : null;
    const gb = isGrid(b) ? b.grid : null;
    const rows = Math.max(ga?.length ?? 1, gb?.length ?? 1);
    const cols = Math.max(ga?.[0]?.length ?? 1, gb?.[0]?.length ?? 1);
    const out: Scalar[][] = [];
    for (let r = 0; r < rows; r++) {
      const line: Scalar[] = [];
      for (let c = 0; c < cols; c++) {
        // An empty cell is null (it compares as "" or 0); only a position past the smaller block's edge is #N/A.
        const at = (g: Scalar[][], rr: number, cc: number): Scalar => {
          const v = g[g.length === 1 ? 0 : rr]?.[g[0].length === 1 ? 0 : cc];
          return v === undefined ? err("#N/A") : v;
        };
        const x = ga ? at(ga, r, c) : (a as Scalar);
        const y = gb ? at(gb, r, c) : (b as Scalar);
        line.push(binaryScalar(op, x, y));
      }
      out.push(line);
    }
    return { grid: out };
  }
  return binaryScalar(op, a, b);
}

function binaryScalar(op: string, a: Scalar, b: Scalar): Scalar {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (op === "&") return (toText(a) as string) + (toText(b) as string);
  if (op === "=") return scalarsEqual(a, b);
  if (op === "<>") return !scalarsEqual(a, b);
  if (op === "<" || op === ">" || op === "<=" || op === ">=") {
    const x = a === null ? (typeof b === "string" ? "" : 0) : a;
    const y = b === null ? (typeof a === "string" ? "" : 0) : b;
    const c = compareScalars(x, y);
    return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
  }
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? err("#DIV/0!", "division by zero") : x / y;
    case "^": {
      const r = x ** y;
      return Number.isFinite(r) ? r : err("#NUM!");
    }
  }
  return err("#ERROR!", `unknown operator ${op}`);
}
