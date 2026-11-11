// Argument handling for the formula library (functions.ts): coercing
// evaluated arguments, matching criteria (SUMIF, COUNTIF, ...), lookups and
// date arithmetic. Split out of functions.ts for its max-lines cap.

import {
  compareScalars,
  dateToSerial,
  err,
  isError,
  isGrid,
  parseDateText,
  scalarsEqual,
  serialToDate,
  toBool,
  toNumber,
  toText,
  type Scalar,
  type SheetError,
  type Value,
} from "./values";

/** Top-left of a grid, or the scalar. */
export function scalarOf(v: Value): Scalar {
  if (isGrid(v)) return v.grid[0]?.[0] ?? null;
  return v;
}

export function cells(v: Value): Scalar[] {
  return isGrid(v) ? v.grid.flat() : [v];
}

export function gridOf(v: Value): Scalar[][] {
  return isGrid(v) ? v.grid : [[v]];
}

/** Numbers for an aggregate: direct args coerce (text -> #VALUE!), range cells skip non-numbers. */
export function numbers(args: Value[]): number[] | SheetError {
  const out: number[] = [];
  for (const a of args) {
    if (isGrid(a)) {
      for (const row of a.grid)
        for (const c of row) {
          if (isError(c)) return c;
          if (typeof c === "number") out.push(c);
        }
    } else {
      if (a === null) continue;
      const n = toNumber(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

export function num(v: Value): number | SheetError {
  return toNumber(scalarOf(v));
}

export function text(v: Value): string | SheetError {
  return toText(scalarOf(v));
}

export function bool(v: Value): boolean | SheetError {
  return toBool(scalarOf(v));
}

/** Run fn over coerced numeric args, returning the first error. */
export function withNums(args: Value[], fn: (...n: number[]) => Value): Value {
  const ns: number[] = [];
  for (const a of args) {
    const n = num(a);
    if (isError(n)) return n;
    ns.push(n);
  }
  return fn(...ns);
}

export function withTexts(args: Value[], fn: (...t: string[]) => Value): Value {
  const ts: string[] = [];
  for (const a of args) {
    const t = text(a);
    if (isError(t)) return t;
    ts.push(t);
  }
  return fn(...ts);
}

export function finite(n: number): Value {
  return Number.isFinite(n) ? n : err("#NUM!");
}

export function roundTo(n: number, digits: number, mode: "half" | "up" | "down"): number {
  const f = 10 ** digits;
  const x = Math.abs(n) * f;
  const fixed = Number(x.toPrecision(15));
  const r = mode === "half" ? Math.round(fixed) : mode === "up" ? Math.ceil(fixed) : Math.floor(fixed);
  return (Math.sign(n) * r) / f;
}

// ── Criteria (SUMIF, COUNTIF, ...) ──────────────────────────────────────────

export function criteriaMatcher(criterion: Scalar): (v: Scalar) => boolean {
  if (typeof criterion === "number" || typeof criterion === "boolean") return (v) => scalarsEqual(v, criterion);
  if (criterion === null) return (v) => v === null || v === "";
  if (isError(criterion)) return (v) => isError(v) && v.error === criterion.error;
  const m = criterion.match(/^(<>|>=|<=|=|>|<)?([\s\S]*)$/)!;
  const op = m[1] ?? "=";
  const rhsText = m[2];
  const rhsNum = rhsText.trim() !== "" ? toNumber(rhsText) : err("#VALUE!");
  const isNum = typeof rhsNum === "number";
  const wildcard = /[*?]/.test(rhsText) ? wildcardRegex(rhsText) : null;
  const eq = (v: Scalar) => {
    if (rhsText === "") return v === null || v === "";
    if (isNum && typeof v === "number") return v === rhsNum;
    if (wildcard) return typeof v === "string" && wildcard.test(v);
    return typeof v === "string" && v.toLowerCase() === rhsText.toLowerCase();
  };
  switch (op) {
    case "=":
      return eq;
    case "<>":
      return (v) => !eq(v);
    default: {
      return (v) => {
        let c: number;
        if (isNum && typeof v === "number") c = v - (rhsNum as number);
        else if (!isNum && typeof v === "string") c = v.localeCompare(rhsText, undefined, { sensitivity: "base" });
        else return false;
        return op === ">" ? c > 0 : op === "<" ? c < 0 : op === ">=" ? c >= 0 : c <= 0;
      };
    }
  }
}

export function wildcardRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) re += escapeRe(pattern[++i]);
    else if (ch === "*") re += "[\\s\\S]*";
    else if (ch === "?") re += "[\\s\\S]";
    else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, "i");
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pairs of (range, criterion) -> mask of matching positions over the first range's shape. */
export function criteriaMask(pairs: Value[]): boolean[] | SheetError {
  let mask: boolean[] | null = null;
  for (let i = 0; i < pairs.length; i += 2) {
    const range = cells(pairs[i]);
    const crit = scalarOf(pairs[i + 1]);
    if (mask && range.length !== mask.length) return err("#VALUE!", "criteria ranges differ in size");
    const match = criteriaMatcher(crit);
    const next: boolean[] = range.map((v, j) => (mask ? mask[j] : true) && match(v));
    mask = next;
  }
  return mask ?? [];
}

// ── Lookup ──────────────────────────────────────────────────────────────────

export function lookupVector(v: Value): Scalar[] {
  const g = gridOf(v);
  if (g.length === 1) return g[0];
  return g.map((r) => r[0] ?? null);
}

/** Index of needle in vec; mode 0 exact, -1 exact-or-next-smaller, 1 exact-or-next-larger, 2 wildcard. */
export function findIndex(needle: Scalar, vec: Scalar[], mode: number, reverse: boolean): number {
  if (mode === 2 && typeof needle === "string") {
    const re = wildcardRegex(needle);
    const order = reverse ? [...vec.keys()].reverse() : [...vec.keys()];
    return order.find((i) => typeof vec[i] === "string" && re.test(vec[i] as string)) ?? -1;
  }
  const order = reverse ? [...vec.keys()].reverse() : [...vec.keys()];
  for (const i of order) if (sameKind(vec[i], needle) && scalarsEqual(vec[i], needle)) return i;
  if (mode === 0 || mode === 2) return -1;
  let best = -1;
  for (const i of order) {
    const v = vec[i];
    if (!sameKind(v, needle)) continue;
    const c = compareScalars(v, needle);
    if (mode === -1 && c < 0 && (best < 0 || compareScalars(v, vec[best]) > 0)) best = i;
    if (mode === 1 && c > 0 && (best < 0 || compareScalars(v, vec[best]) < 0)) best = i;
  }
  return best;
}

export function sameKind(a: Scalar, b: Scalar): boolean {
  return typeof a === typeof b || (a === null && b === "") || (b === null && a === "");
}

/** Sorted approximate match (VLOOKUP TRUE, MATCH 1): the last position <= needle. */
export function approxSorted(needle: Scalar, vec: Scalar[], descending = false): number {
  let best = -1;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (v === null || !sameKind(v, needle)) continue;
    const c = compareScalars(v, needle);
    if (descending ? c >= 0 : c <= 0) best = i;
    else break;
  }
  return best;
}

// ── Date helpers ────────────────────────────────────────────────────────────

export function dateArg(v: Value): number | SheetError {
  const s = scalarOf(v);
  if (typeof s === "string") {
    const d = parseDateText(s);
    return d ?? err("#VALUE!", `"${s}" is not a date`);
  }
  return toNumber(s);
}

export function addMonths(serial: number, months: number): { y: number; m: number; d: number } {
  const d = serialToDate(serial);
  const total = d.y * 12 + (d.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = serialToDate(dateToSerial(y, m + 1, 1) - 1).d;
  return { y, m, d: Math.min(d.d, last) };
}
