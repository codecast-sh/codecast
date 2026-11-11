// The recalculation engine. A Workbook holds every tab's cell inputs, parses
// formulas once, tracks which cells each formula reads (single cells and
// ranges), and evaluates lazily: a read evaluates the cell's precedents first
// in an explicit-stack DFS (so a 10k-row chain cannot overflow the call
// stack), caches every result, and an edit clears the cache of exactly the
// cells downstream of it. A cycle marks every cell on it #CIRC!.
import { FUNCTIONS, type FnContext } from "./functions";
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
  type Scalar,
  type Value,
} from "./values";
import type { Rect } from "./refs";

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

export type CellInfo = {
  input: string;
  value: Scalar;
  implied?: ImpliedFormat;
  formula: boolean;
};

/** Changes above this size re-dirty every formula instead of walking dependents. */
const BULK_THRESHOLD = 256;
/** An invalidation walk that has dirtied this many cells marks every formula stale instead. */
const DIRTY_ALL_AFTER = 4_000;
const DIRTY_ALL_WORK = 250_000;
const ADDRESS_ONLY = new Set(["ROW", "COLUMN", "ROWS", "COLUMNS"]);
const VOLATILE = new Set(["TODAY", "NOW"]);

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
    if (changed.length > BULK_THRESHOLD) this.dirtyAll();
    else this.invalidate(changed);
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
        case "fn":
          // ROW(A1), COLUMN(A1), ROWS(A1:A9), COLUMNS(...) read an address, not a value.
          if (ADDRESS_ONLY.has(n.name)) {
            for (const a of n.args) if (a.t !== "ref" && a.t !== "range") walk(a);
            return;
          }
          if (VOLATILE.has(n.name)) volatile = true;
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
    walk(e.ast!);
    if (volatile) this.volatile.add(id);
    else this.volatile.delete(id);
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
    if (!e) return null;
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
    if (!e) return null;
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
      e.value = this.compute(e);
      e.state = 2;
    }
  }

  private compute(e: Entry): Scalar {
    if (e.syntax) return err("#ERROR!", e.syntax);
    return topLevel(this.evalNode(e.ast!, e.ti, { col: e.col, row: e.row, now: this.now() }));
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
      case "name":
        return err("#NAME?", `unknown name ${n.v}`);
      case "ref": {
        const t = this.resolveTab(n.tab, ti);
        if (t === null) return err("#REF!", `no tab named ${n.tab}`);
        return this.valueById(cid(t, n.col, n.row));
      }
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
        const x = ga ? (ga[ga.length === 1 ? 0 : r]?.[ga[0].length === 1 ? 0 : c] ?? err("#N/A")) : (a as Scalar);
        const y = gb ? (gb[gb.length === 1 ? 0 : r]?.[gb[0].length === 1 ? 0 : c] ?? err("#N/A")) : (b as Scalar);
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
