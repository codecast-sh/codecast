// Functions that return a block of values and spill it into the cells below
// and to the right of the formula: FILTER, UNIQUE, SORT, SORTBY, SEQUENCE,
// TRANSPOSE. The engine places the block (engine.ts, spill anchors); these
// only compute it. Semantics follow Google Sheets / Excel 365.
import { compareScalars, err, isError, isGrid, scalarsEqual, toBool, toNumber, type Grid, type Scalar, type Value } from "./values";
import type { FnDef } from "./functions";

/** The names whose formulas spill. A formula spills only when one of these is its outermost function. */
export const ARRAY_FUNCTIONS = new Set(["FILTER", "UNIQUE", "SORT", "SORTBY", "SEQUENCE", "TRANSPOSE", "SPLIT"]);

const MAX_CELLS = 200_000;

function rowsOf(v: Value): Scalar[][] {
  return isGrid(v) ? v.grid.map((r) => [...r]) : [[v]];
}

function block(rows: Scalar[][], ifEmpty?: Value): Value {
  if (!rows.length || !rows[0]?.length) return ifEmpty !== undefined ? ifEmpty : err("#N/A", "nothing to return");
  if (rows.length * rows[0].length > MAX_CELLS) return err("#NUM!", "the result is too large");
  return { grid: rows } satisfies Grid;
}

function transpose(rows: Scalar[][]): Scalar[][] {
  const w = Math.max(0, ...rows.map((r) => r.length));
  return Array.from({ length: w }, (_, c) => rows.map((r) => r[c] ?? null));
}

function intArg(v: Value | undefined, dflt: number): number | Scalar {
  if (v === undefined || v === null) return dflt;
  const n = toNumber(isGrid(v) ? (v.grid[0]?.[0] ?? null) : v);
  return isError(n) ? n : Math.trunc(n);
}

/** The rows of a table ordered by keys: each key a column vector and a direction (1 up, -1 down). Stable. */
function orderRows(rows: Scalar[][], keys: Array<{ vec: Scalar[]; dir: number }>): Scalar[][] {
  const idx = rows.map((_, i) => i);
  idx.sort((a, b) => {
    for (const k of keys) {
      const c = compareScalars(k.vec[a] ?? null, k.vec[b] ?? null);
      if (c) return c * k.dir;
    }
    return a - b;
  });
  return idx.map((i) => rows[i]);
}

export const ARRAY_FUNCTION_DEFS: Record<string, FnDef> = {
  FILTER: {
    min: 2,
    eager: ([range, ...rest]) => {
      const rows = rowsOf(range);
      // FILTER(range, condition1, [condition2, ...]): each condition a column as tall as the range.
      const conds = rest.map(rowsOf);
      for (const c of conds) {
        if (c.length !== rows.length) return err("#VALUE!", "the condition and the range differ in size");
        for (const r of c) if (isError(r[0])) return r[0];
      }
      const kept = rows.filter((_, i) =>
        conds.every((c) => {
          const b = toBool(c[i][0] ?? false);
          return !isError(b) && b;
        }),
      );
      return block(kept, err("#N/A", "no rows match"));
    },
  },
  UNIQUE: {
    min: 1,
    max: 3,
    eager: ([range, byColArg, onceArg]) => {
      const byCol = byColArg !== undefined && toBool(scalarOfV(byColArg)) === true;
      const once = onceArg !== undefined && toBool(scalarOfV(onceArg)) === true;
      const rows = byCol ? transpose(rowsOf(range)) : rowsOf(range);
      const same = (a: Scalar[], b: Scalar[]) => a.length === b.length && a.every((v, i) => scalarsEqual(v, b[i]) && typeof v === typeof b[i]);
      const groups: Array<{ row: Scalar[]; n: number }> = [];
      for (const r of rows) {
        // Empty rows count once, like any other value; trailing blank rows of a whole-column read are dropped.
        const g = groups.find((x) => same(x.row, r));
        if (g) g.n++;
        else groups.push({ row: r, n: 1 });
      }
      while (groups.length && groups[groups.length - 1].row.every((v) => v === null || v === "")) groups.pop();
      const out = groups.filter((g) => !once || g.n === 1).map((g) => g.row);
      return block(byCol ? transpose(out) : out);
    },
  },
  SORT: {
    min: 1,
    max: 4,
    eager: ([range, indexArg, orderArg, byColArg]) => {
      const byCol = byColArg !== undefined && toBool(scalarOfV(byColArg)) === true;
      const rows = byCol ? transpose(rowsOf(range)) : rowsOf(range);
      const index = intArg(indexArg, 1);
      const order = intArg(orderArg, 1);
      if (typeof index !== "number") return index;
      if (typeof order !== "number") return order;
      if (index < 1 || index > (rows[0]?.length ?? 0)) return err("#VALUE!", "the sort column is outside the range");
      // Excel says 1 / -1, Google TRUE / FALSE: FALSE (0) and -1 both sort descending.
      const desc = order <= 0;
      const sorted = orderRows(rows, [{ vec: rows.map((r) => r[index - 1]), dir: desc ? -1 : 1 }]);
      return block(byCol ? transpose(sorted) : sorted);
    },
  },
  SORTBY: {
    min: 2,
    eager: ([range, ...pairs]) => {
      const rows = rowsOf(range);
      const keys: Array<{ vec: Scalar[]; dir: number }> = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const vec = rowsOf(pairs[i]).map((r) => r[0]);
        if (vec.length !== rows.length) return err("#VALUE!", "a sort range differs in size from the range");
        const dir = intArg(pairs[i + 1], 1);
        if (typeof dir !== "number") return dir;
        keys.push({ vec, dir: dir < 0 ? -1 : 1 });
      }
      return block(orderRows(rows, keys));
    },
  },
  SEQUENCE: {
    min: 1,
    max: 4,
    eager: ([rowsArg, colsArg, startArg, stepArg]) => {
      const n = intArg(rowsArg, 1), m = intArg(colsArg, 1);
      const start = toNumber(scalarOfV(startArg ?? 1)), step = toNumber(scalarOfV(stepArg ?? 1));
      for (const x of [n, m, start, step]) if (typeof x !== "number") return x as Scalar;
      if ((n as number) < 1 || (m as number) < 1) return err("#VALUE!", "rows and columns must be at least 1");
      const out: Scalar[][] = [];
      for (let r = 0; r < (n as number); r++) {
        const line: Scalar[] = [];
        for (let c = 0; c < (m as number); c++) line.push((start as number) + (r * (m as number) + c) * (step as number));
        out.push(line);
      }
      return block(out);
    },
  },
  TRANSPOSE: {
    min: 1,
    max: 1,
    eager: ([range]) => block(transpose(rowsOf(range))),
  },
};

function scalarOfV(v: Value): Scalar {
  return isGrid(v) ? (v.grid[0]?.[0] ?? null) : v;
}
