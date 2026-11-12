// Operator arithmetic for the recalculation engine (engine.ts): binary
// operators over scalars and broadcast grids, and the scalar helpers its
// evaluator applies to a result.
import { scalarOf } from "./functionArgs";
import {
  compareScalars,
  err,
  isError,
  isGrid,
  scalarsEqual,
  toNumber,
  toText,
  type SheetError,
  type Scalar,
  type Value,
} from "./values";

export function intOf(v: Value): number | SheetError {
  const n = toNumber(scalarOf(v));
  return isError(n) ? n : Math.trunc(n);
}

export function topLevel(v: Value): Scalar {
  const s = scalarOf(v);
  if (typeof s === "number" && !Number.isFinite(s)) return err("#NUM!");
  return s;
}

export function mapScalar(v: Value, f: (s: Scalar) => Scalar): Value {
  if (isGrid(v)) return { grid: v.grid.map((r) => r.map(f)) };
  return f(v);
}

export function binary(op: string, a: Value, b: Value): Value {
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
