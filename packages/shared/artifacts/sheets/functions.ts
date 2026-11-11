// The formula function library. Each function takes evaluated arguments
// (scalars or grids from ranges) and returns a value; the few that must not
// evaluate every argument (IF, IFERROR, CHOOSE, ...) are "lazy" and receive
// thunks. Semantics follow Google Sheets / Excel: ranges skip text in
// aggregates, errors propagate, criteria take ">5", "<>x", "a*".
import {
  dateToSerial,
  err,
  isError,
  nowSerial,
  numberToText,
  parseDateText,
  scalarsEqual,
  serialToDate,
  todaySerial,
  toBool,
  toNumber,
  toText,
  type Grid,
  type Scalar,
  type Value,
} from "./values";
import { formatWithCode } from "./format";
import { ARRAY_FUNCTION_DEFS } from "./arrayFunctions";
import { MORE_FUNCTION_DEFS, SPLIT_DEF, STAT_FUNCTION_DEFS, TIME_FUNCTION_DEFS, subtotalDef } from "./moreFunctions";
import {
  scalarOf,
  cells,
  gridOf,
  numbers,
  num,
  text,
  bool,
  withNums,
  withTexts,
  finite,
  roundTo,
  criteriaMatcher,
  wildcardRegex,
  criteriaMask,
  lookupVector,
  findIndex,
  approxSorted,
  dateArg,
  addMonths,
} from "./functionArgs";

export type FnContext = { col: number; row: number; now: Date };
type Eager = (args: Value[], ctx: FnContext) => Value;
type Lazy = (args: Array<() => Value>, ctx: FnContext) => Value;
export type FnDef = { eager?: Eager; lazy?: Lazy; min: number; max?: number };

// ── The library ─────────────────────────────────────────────────────────────

const agg = (fn: (ns: number[]) => Value): FnDef => ({
  min: 1,
  eager: (args) => {
    const ns = numbers(args);
    return isError(ns) ? ns : fn(ns);
  },
});

const ifsAgg = (fn: (vals: number[]) => Value, valuesFirst: boolean): FnDef => ({
  min: valuesFirst ? 3 : 2,
  eager: (args) => {
    const values = valuesFirst ? cells(args[0]) : cells(args[0]);
    const pairs = valuesFirst ? args.slice(1) : args;
    if (pairs.length % 2 !== 0) return err("#N/A", "criteria come in range, criterion pairs");
    const mask = criteriaMask(pairs);
    if (isError(mask)) return mask;
    const picked: number[] = [];
    mask.forEach((ok, i) => {
      const v = values[i];
      if (ok && typeof v === "number") picked.push(v);
    });
    return fn(picked);
  },
});

const sumOf = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const avgOf = (ns: number[]): Value => (ns.length ? sumOf(ns) / ns.length : err("#DIV/0!"));

function variance(ns: number[], sample: boolean): Value {
  const n = ns.length;
  if (n < (sample ? 2 : 1)) return err("#DIV/0!");
  const mean = sumOf(ns) / n;
  return ns.reduce((a, x) => a + (x - mean) ** 2, 0) / (sample ? n - 1 : n);
}

export const FUNCTIONS: Record<string, FnDef> = {
  // Math and aggregates
  SUM: agg(sumOf),
  AVERAGE: agg(avgOf),
  MIN: agg((ns) => (ns.length ? Math.min(...ns) : 0)),
  MAX: agg((ns) => (ns.length ? Math.max(...ns) : 0)),
  PRODUCT: agg((ns) => ns.reduce((a, b) => a * b, 1)),
  MEDIAN: agg((ns) => {
    if (!ns.length) return err("#NUM!");
    const s = [...ns].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }),
  STDEV: agg((ns) => {
    const v = variance(ns, true);
    return typeof v === "number" ? Math.sqrt(v) : v;
  }),
  STDEVP: agg((ns) => {
    const v = variance(ns, false);
    return typeof v === "number" ? Math.sqrt(v) : v;
  }),
  VAR: agg((ns) => variance(ns, true)),
  COUNT: { min: 1, eager: (args) => args.flatMap(cells).filter((c) => typeof c === "number").length },
  COUNTA: { min: 1, eager: (args) => args.flatMap(cells).filter((c) => c !== null && c !== "").length },
  COUNTBLANK: { min: 1, max: 1, eager: (args) => cells(args[0]).filter((c) => c === null || c === "").length },
  SUMIF: {
    min: 2,
    max: 3,
    eager: (args) => {
      const crit = criteriaMatcher(scalarOf(args[1]));
      const range = cells(args[0]);
      const sumRange = args[2] !== undefined ? cells(args[2]) : range;
      let total = 0;
      range.forEach((v, i) => {
        const s = sumRange[i];
        if (crit(v) && typeof s === "number") total += s;
      });
      return total;
    },
  },
  SUMIFS: ifsAgg(sumOf, true),
  AVERAGEIF: {
    min: 2,
    max: 3,
    eager: (args) => {
      const crit = criteriaMatcher(scalarOf(args[1]));
      const range = cells(args[0]);
      const avgRange = args[2] !== undefined ? cells(args[2]) : range;
      const picked = range.flatMap((v, i) => (crit(v) && typeof avgRange[i] === "number" ? [avgRange[i] as number] : []));
      return avgOf(picked);
    },
  },
  AVERAGEIFS: ifsAgg(avgOf, true),
  COUNTIF: {
    min: 2,
    max: 2,
    eager: (args) => {
      const crit = criteriaMatcher(scalarOf(args[1]));
      return cells(args[0]).filter(crit).length;
    },
  },
  COUNTIFS: {
    min: 2,
    eager: (args) => {
      if (args.length % 2 !== 0) return err("#N/A", "criteria come in range, criterion pairs");
      const mask = criteriaMask(args);
      return isError(mask) ? mask : mask.filter(Boolean).length;
    },
  },
  MAXIFS: ifsAgg((ns) => (ns.length ? Math.max(...ns) : 0), true),
  MINIFS: ifsAgg((ns) => (ns.length ? Math.min(...ns) : 0), true),
  SUMPRODUCT: {
    min: 1,
    eager: (args) => {
      const arrays = args.map(cells);
      const n = arrays[0].length;
      if (arrays.some((a) => a.length !== n)) return err("#VALUE!", "ranges differ in size");
      let total = 0;
      for (let i = 0; i < n; i++) {
        let p = 1;
        for (const a of arrays) {
          const v = a[i];
          if (isError(v)) return v;
          p *= typeof v === "number" ? v : 0;
        }
        total += p;
      }
      return total;
    },
  },
  ROUND: { min: 1, max: 2, eager: (a) => withNums(a, (n, d = 0) => roundTo(n, Math.trunc(d), "half")) },
  ROUNDUP: { min: 1, max: 2, eager: (a) => withNums(a, (n, d = 0) => roundTo(n, Math.trunc(d), "up")) },
  ROUNDDOWN: { min: 1, max: 2, eager: (a) => withNums(a, (n, d = 0) => roundTo(n, Math.trunc(d), "down")) },
  INT: { min: 1, max: 1, eager: (a) => withNums(a, (n) => Math.floor(n)) },
  TRUNC: { min: 1, max: 2, eager: (a) => withNums(a, (n, d = 0) => roundTo(n, Math.trunc(d), "down")) },
  ABS: { min: 1, max: 1, eager: (a) => withNums(a, Math.abs) },
  SIGN: { min: 1, max: 1, eager: (a) => withNums(a, Math.sign) },
  MOD: {
    min: 2,
    max: 2,
    eager: (a) => withNums(a, (n, d) => (d === 0 ? err("#DIV/0!") : n - d * Math.floor(n / d))),
  },
  POWER: { min: 2, max: 2, eager: (a) => withNums(a, (b, e) => finite(b ** e)) },
  SQRT: { min: 1, max: 1, eager: (a) => withNums(a, (n) => (n < 0 ? err("#NUM!") : Math.sqrt(n))) },
  EXP: { min: 1, max: 1, eager: (a) => withNums(a, (n) => finite(Math.exp(n))) },
  LN: { min: 1, max: 1, eager: (a) => withNums(a, (n) => (n <= 0 ? err("#NUM!") : Math.log(n))) },
  LOG: { min: 1, max: 2, eager: (a) => withNums(a, (n, b = 10) => (n <= 0 || b <= 0 || b === 1 ? err("#NUM!") : Math.log(n) / Math.log(b))) },
  LOG10: { min: 1, max: 1, eager: (a) => withNums(a, (n) => (n <= 0 ? err("#NUM!") : Math.log10(n))) },
  PI: { min: 0, max: 0, eager: () => Math.PI },
  CEILING: {
    min: 1,
    max: 2,
    eager: (a) => withNums(a, (n, s = 1) => (s === 0 ? 0 : Math.ceil(n / s) * s)),
  },
  FLOOR: {
    min: 1,
    max: 2,
    eager: (a) => withNums(a, (n, s = 1) => (s === 0 ? err("#DIV/0!") : Math.floor(n / s) * s)),
  },

  // Logic
  IF: {
    min: 2,
    max: 3,
    lazy: (args) => {
      const c = bool(args[0]());
      if (isError(c)) return c;
      if (c) return args[1]();
      return args[2] ? args[2]() : false;
    },
  },
  IFS: {
    min: 2,
    lazy: (args) => {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const c = bool(args[i]());
        if (isError(c)) return c;
        if (c) return args[i + 1]();
      }
      return err("#N/A", "no condition was true");
    },
  },
  IFERROR: {
    min: 2,
    max: 2,
    lazy: (args) => {
      const v = args[0]();
      return isError(scalarOf(v)) ? args[1]() : v;
    },
  },
  IFNA: {
    min: 2,
    max: 2,
    lazy: (args) => {
      const v = args[0]();
      const s = scalarOf(v);
      return isError(s) && s.error === "#N/A" ? args[1]() : v;
    },
  },
  SWITCH: {
    min: 3,
    lazy: (args) => {
      const subject = scalarOf(args[0]());
      if (isError(subject)) return subject;
      let i = 1;
      for (; i + 1 < args.length; i += 2) if (scalarsEqual(scalarOf(args[i]()), subject)) return args[i + 1]();
      return i < args.length ? args[i]() : err("#N/A", "no case matched");
    },
  },
  CHOOSE: {
    min: 2,
    lazy: (args) => {
      const i = num(args[0]());
      if (isError(i)) return i;
      const k = Math.trunc(i);
      return k >= 1 && k < args.length ? args[k]() : err("#VALUE!", "index out of range");
    },
  },
  AND: {
    min: 1,
    eager: (args) => {
      let result = true;
      for (const c of args.flatMap(cells)) {
        if (c === null || typeof c === "string") continue;
        const b = toBool(c);
        if (isError(b)) return b;
        result = result && b;
      }
      return result;
    },
  },
  OR: {
    min: 1,
    eager: (args) => {
      let result = false;
      for (const c of args.flatMap(cells)) {
        if (c === null || typeof c === "string") continue;
        const b = toBool(c);
        if (isError(b)) return b;
        result = result || b;
      }
      return result;
    },
  },
  XOR: {
    min: 1,
    eager: (args) => {
      let n = 0;
      for (const c of args.flatMap(cells)) {
        if (c === null || typeof c === "string") continue;
        const b = toBool(c);
        if (isError(b)) return b;
        if (b) n++;
      }
      return n % 2 === 1;
    },
  },
  NOT: { min: 1, max: 1, eager: (a) => {
    const b = bool(a[0]);
    return isError(b) ? b : !b;
  } },
  TRUE: { min: 0, max: 0, eager: () => true },
  FALSE: { min: 0, max: 0, eager: () => false },
  ISBLANK: { min: 1, max: 1, eager: (a) => scalarOf(a[0]) === null },
  ISNUMBER: { min: 1, max: 1, eager: (a) => typeof scalarOf(a[0]) === "number" },
  ISTEXT: { min: 1, max: 1, eager: (a) => typeof scalarOf(a[0]) === "string" },
  ISLOGICAL: { min: 1, max: 1, eager: (a) => typeof scalarOf(a[0]) === "boolean" },
  ISERROR: { min: 1, max: 1, eager: (a) => isError(scalarOf(a[0])) },
  ISERR: { min: 1, max: 1, eager: (a) => {
    const s = scalarOf(a[0]);
    return isError(s) && s.error !== "#N/A";
  } },
  ISNA: { min: 1, max: 1, eager: (a) => {
    const s = scalarOf(a[0]);
    return isError(s) && s.error === "#N/A";
  } },
  NA: { min: 0, max: 0, eager: () => err("#N/A") },

  // Lookup
  XLOOKUP: {
    min: 3,
    max: 6,
    lazy: (args) => {
      const needle = scalarOf(args[0]());
      if (isError(needle)) return needle;
      const lookup = args[1]();
      const ret = args[2]();
      const mode = args[4] ? num(args[4]()) : 0;
      const search = args[5] ? num(args[5]()) : 1;
      if (isError(mode)) return mode;
      if (isError(search)) return search;
      const lg = gridOf(lookup);
      const vertical = lg.length > 1 || (lg[0]?.length ?? 0) === 1;
      const vec = lookupVector(lookup);
      const i = findIndex(needle, vec, mode, search < 0);
      if (i < 0) return args[3] ? args[3]() : err("#N/A", `${toText(needle)} not found`);
      const rg = gridOf(ret);
      if (vertical) {
        const row = rg[i];
        if (!row) return err("#VALUE!", "return range is shorter than the lookup range");
        return row.length === 1 ? row[0] : { grid: [row] };
      }
      const col = rg.map((r) => r[i] ?? null);
      return col.length === 1 ? col[0] : { grid: col.map((c) => [c]) };
    },
  },
  VLOOKUP: {
    min: 3,
    max: 4,
    eager: (args) => {
      const needle = scalarOf(args[0]);
      if (isError(needle)) return needle;
      const table = gridOf(args[1]);
      const col = num(args[2]);
      if (isError(col)) return col;
      const approx = args[3] !== undefined ? bool(args[3]) : true;
      if (isError(approx)) return approx;
      if (col < 1 || col > (table[0]?.length ?? 0)) return err("#REF!", "column index is outside the table");
      const first = table.map((r) => r[0] ?? null);
      const i = approx ? approxSorted(needle, first) : findIndex(needle, first, 0, false);
      if (i < 0) return err("#N/A", `${toText(needle)} not found`);
      return table[i][Math.trunc(col) - 1] ?? null;
    },
  },
  HLOOKUP: {
    min: 3,
    max: 4,
    eager: (args) => {
      const needle = scalarOf(args[0]);
      if (isError(needle)) return needle;
      const table = gridOf(args[1]);
      const row = num(args[2]);
      if (isError(row)) return row;
      const approx = args[3] !== undefined ? bool(args[3]) : true;
      if (isError(approx)) return approx;
      if (row < 1 || row > table.length) return err("#REF!", "row index is outside the table");
      const first = table[0] ?? [];
      const i = approx ? approxSorted(needle, first) : findIndex(needle, first, 0, false);
      if (i < 0) return err("#N/A", `${toText(needle)} not found`);
      return table[Math.trunc(row) - 1][i] ?? null;
    },
  },
  INDEX: {
    min: 2,
    max: 3,
    eager: (args) => {
      const g = gridOf(args[0]);
      const r = num(args[1]);
      const c = args[2] !== undefined ? num(args[2]) : 1;
      if (isError(r)) return r;
      if (isError(c)) return c;
      let ri = Math.trunc(r), ci = Math.trunc(c);
      // A single row: INDEX(A1:E1, 3) reads the 3rd column.
      if (g.length === 1 && args[2] === undefined) {
        ci = ri;
        ri = 1;
      }
      if (ri === 0 && ci >= 1) return { grid: g.map((row) => [row[ci - 1] ?? null]) };
      if (ci === 0 && ri >= 1) return g[ri - 1] ? { grid: [g[ri - 1]] } : err("#REF!");
      const row = g[ri - 1];
      if (!row || ci < 1 || ci > row.length) return err("#REF!", "index is outside the range");
      return row[ci - 1] ?? null;
    },
  },
  MATCH: {
    min: 2,
    max: 3,
    eager: (args) => {
      const needle = scalarOf(args[0]);
      if (isError(needle)) return needle;
      const vec = lookupVector(args[1]);
      const type = args[2] !== undefined ? num(args[2]) : 1;
      if (isError(type)) return type;
      const i =
        type === 0
          ? findIndex(needle, vec, typeof needle === "string" && /[*?]/.test(needle) ? 2 : 0, false)
          : approxSorted(needle, vec, type < 0);
      return i < 0 ? err("#N/A", `${toText(needle)} not found`) : i + 1;
    },
  },
  XMATCH: {
    min: 2,
    max: 4,
    eager: (args) => {
      const needle = scalarOf(args[0]);
      if (isError(needle)) return needle;
      const mode = args[2] !== undefined ? num(args[2]) : 0;
      const search = args[3] !== undefined ? num(args[3]) : 1;
      if (isError(mode)) return mode;
      if (isError(search)) return search;
      const i = findIndex(needle, lookupVector(args[1]), mode, search < 0);
      return i < 0 ? err("#N/A", `${toText(needle)} not found`) : i + 1;
    },
  },
  ROWS: { min: 1, max: 1, eager: (a) => gridOf(a[0]).length },
  COLUMNS: { min: 1, max: 1, eager: (a) => gridOf(a[0])[0]?.length ?? 0 },

  // Text
  CONCAT: { min: 1, eager: (args) => joinTexts(args.flatMap(cells), "") },
  CONCATENATE: { min: 1, eager: (args) => joinTexts(args.flatMap(cells), "") },
  TEXTJOIN: {
    min: 3,
    eager: (args) => {
      const delim = text(args[0]);
      if (isError(delim)) return delim;
      const skip = bool(args[1]);
      if (isError(skip)) return skip;
      const items = args.slice(2).flatMap(cells).filter((c) => !(skip && (c === null || c === "")));
      return joinTexts(items, delim);
    },
  },
  LEN: { min: 1, max: 1, eager: (a) => withTexts(a, (s) => s.length) },
  LEFT: {
    min: 1,
    max: 2,
    eager: (a) => {
      const s = text(a[0]);
      const n = a[1] !== undefined ? num(a[1]) : 1;
      if (isError(s)) return s;
      if (isError(n)) return n;
      return n < 0 ? err("#VALUE!") : s.slice(0, Math.trunc(n));
    },
  },
  RIGHT: {
    min: 1,
    max: 2,
    eager: (a) => {
      const s = text(a[0]);
      const n = a[1] !== undefined ? num(a[1]) : 1;
      if (isError(s)) return s;
      if (isError(n)) return n;
      if (n < 0) return err("#VALUE!");
      const k = Math.trunc(n);
      return k === 0 ? "" : s.slice(-k);
    },
  },
  MID: {
    min: 3,
    max: 3,
    eager: (a) => {
      const s = text(a[0]);
      const start = num(a[1]);
      const len = num(a[2]);
      if (isError(s)) return s;
      if (isError(start)) return start;
      if (isError(len)) return len;
      if (start < 1 || len < 0) return err("#VALUE!");
      return s.slice(start - 1, start - 1 + len);
    },
  },
  UPPER: { min: 1, max: 1, eager: (a) => withTexts(a, (s) => s.toUpperCase()) },
  LOWER: { min: 1, max: 1, eager: (a) => withTexts(a, (s) => s.toLowerCase()) },
  PROPER: { min: 1, max: 1, eager: (a) => withTexts(a, (s) => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, p, c) => p + c.toUpperCase())) },
  TRIM: { min: 1, max: 1, eager: (a) => withTexts(a, (s) => s.trim().replace(/ {2,}/g, " ")) },
  SUBSTITUTE: {
    min: 3,
    max: 4,
    eager: (a) => {
      const parts = a.slice(0, 3).map(text);
      const bad = parts.find(isError);
      if (bad) return bad;
      const [s, from, to] = parts as string[];
      if (from === "") return s;
      if (a[3] === undefined) return s.split(from).join(to);
      const nth = num(a[3]);
      if (isError(nth)) return nth;
      let idx = -1;
      for (let k = 0; k < nth; k++) {
        idx = s.indexOf(from, idx + 1);
        if (idx < 0) return s;
      }
      return s.slice(0, idx) + to + s.slice(idx + from.length);
    },
  },
  REPLACE: {
    min: 4,
    max: 4,
    eager: (a) => {
      const s = text(a[0]);
      const start = num(a[1]);
      const len = num(a[2]);
      const repl = text(a[3]);
      for (const x of [s, start, len, repl]) if (isError(x)) return x;
      const st = (start as number) - 1;
      return (s as string).slice(0, st) + repl + (s as string).slice(st + (len as number));
    },
  },
  FIND: {
    min: 2,
    max: 3,
    eager: (a) => {
      const needle = text(a[0]);
      const hay = text(a[1]);
      const from = a[2] !== undefined ? num(a[2]) : 1;
      for (const x of [needle, hay, from]) if (isError(x)) return x;
      const i = (hay as string).indexOf(needle as string, (from as number) - 1);
      return i < 0 ? err("#VALUE!", `"${needle}" not found`) : i + 1;
    },
  },
  SEARCH: {
    min: 2,
    max: 3,
    eager: (a) => {
      const needle = text(a[0]);
      const hay = text(a[1]);
      const from = a[2] !== undefined ? num(a[2]) : 1;
      for (const x of [needle, hay, from]) if (isError(x)) return x;
      const re = new RegExp(wildcardRegex(needle as string).source.slice(1, -1), "i");
      const sub = (hay as string).slice((from as number) - 1);
      const m = sub.search(re);
      return m < 0 ? err("#VALUE!", `"${needle}" not found`) : m + (from as number);
    },
  },
  REPT: {
    min: 2,
    max: 2,
    eager: (a) => {
      const s = text(a[0]);
      const n = num(a[1]);
      if (isError(s)) return s;
      if (isError(n)) return n;
      return n < 0 || s.length * n > 32_000 ? err("#VALUE!") : s.repeat(Math.trunc(n));
    },
  },
  EXACT: { min: 2, max: 2, eager: (a) => withTexts(a, (x, y) => x === y) },
  VALUE: {
    min: 1,
    max: 1,
    eager: (a) => {
      const s = scalarOf(a[0]);
      if (typeof s === "number") return s;
      return toNumber(typeof s === "string" ? s : toText(s) as string);
    },
  },
  TEXT: {
    min: 2,
    max: 2,
    eager: (a) => {
      const v = scalarOf(a[0]);
      const code = text(a[1]);
      if (isError(v)) return v;
      if (isError(code)) return code;
      if (typeof v !== "number") {
        const d = typeof v === "string" ? parseDateText(v) : null;
        if (d === null) return toText(v);
        return formatWithCode(d, code);
      }
      return formatWithCode(v, code);
    },
  },
  CHAR: { min: 1, max: 1, eager: (a) => withNums(a, (n) => String.fromCharCode(Math.trunc(n))) },
  CODE: { min: 1, max: 1, eager: (a) => withTexts(a, (s) => (s ? s.charCodeAt(0) : err("#VALUE!"))) },

  // Dates
  TODAY: { min: 0, max: 0, eager: (_a, ctx) => todaySerial(ctx.now) },
  NOW: { min: 0, max: 0, eager: (_a, ctx) => nowSerial(ctx.now) },
  DATE: {
    min: 3,
    max: 3,
    eager: (a) =>
      withNums(a, (y, m, d) => {
        const total = Math.trunc(y) * 12 + Math.trunc(m) - 1;
        return dateToSerial(Math.floor(total / 12), (total % 12 + 12) % 12 + 1, 1) + Math.trunc(d) - 1;
      }),
  },
  DATEVALUE: {
    min: 1,
    max: 1,
    eager: (a) => {
      const s = text(a[0]);
      if (isError(s)) return s;
      const d = parseDateText(s);
      return d === null ? err("#VALUE!", `"${s}" is not a date`) : Math.floor(d);
    },
  },
  YEAR: { min: 1, max: 1, eager: (a) => dateFn(a[0], (d) => d.y) },
  MONTH: { min: 1, max: 1, eager: (a) => dateFn(a[0], (d) => d.m) },
  DAY: { min: 1, max: 1, eager: (a) => dateFn(a[0], (d) => d.d) },
  HOUR: { min: 1, max: 1, eager: (a) => dateFn(a[0], (d) => d.h) },
  MINUTE: { min: 1, max: 1, eager: (a) => dateFn(a[0], (d) => d.min) },
  WEEKDAY: {
    min: 1,
    max: 2,
    eager: (a) => {
      const type = a[1] !== undefined ? num(a[1]) : 1;
      if (isError(type)) return type;
      return dateFn(a[0], (d) => (type === 2 ? ((d.dow + 6) % 7) + 1 : type === 3 ? (d.dow + 6) % 7 : d.dow + 1));
    },
  },
  EDATE: {
    min: 2,
    max: 2,
    eager: (a) => {
      const s = dateArg(a[0]);
      const m = num(a[1]);
      if (isError(s)) return s;
      if (isError(m)) return m;
      const r = addMonths(s, Math.trunc(m));
      return dateToSerial(r.y, r.m, r.d);
    },
  },
  EOMONTH: {
    min: 2,
    max: 2,
    eager: (a) => {
      const s = dateArg(a[0]);
      const m = num(a[1]);
      if (isError(s)) return s;
      if (isError(m)) return m;
      const r = addMonths(s, Math.trunc(m) + 1);
      return dateToSerial(r.y, r.m, 1) - 1;
    },
  },
  DAYS: {
    min: 2,
    max: 2,
    eager: (a) => {
      const e = dateArg(a[0]);
      const s = dateArg(a[1]);
      if (isError(e)) return e;
      if (isError(s)) return s;
      return Math.floor(e) - Math.floor(s);
    },
  },
  DATEDIF: {
    min: 3,
    max: 3,
    eager: (a) => {
      const s = dateArg(a[0]);
      const e = dateArg(a[1]);
      const unit = text(a[2]);
      if (isError(s)) return s;
      if (isError(e)) return e;
      if (isError(unit)) return unit;
      if (e < s) return err("#NUM!", "start is after end");
      const ds = serialToDate(s), de = serialToDate(e);
      let months = (de.y - ds.y) * 12 + (de.m - ds.m);
      if (de.d < ds.d) months--;
      switch (unit.toUpperCase()) {
        case "D":
          return Math.floor(e) - Math.floor(s);
        case "M":
          return months;
        case "Y":
          return Math.floor(months / 12);
        case "YM":
          return months % 12;
        case "MD":
          return de.d >= ds.d ? de.d - ds.d : Math.floor(e) - dateToSerial(addMonths(s, months).y, addMonths(s, months).m, addMonths(s, months).d);
        default:
          return err("#NUM!", `unknown unit ${unit}`);
      }
    },
  },
  NETWORKDAYS: {
    min: 2,
    max: 3,
    eager: (a) => {
      const s = dateArg(a[0]);
      const e = dateArg(a[1]);
      if (isError(s)) return s;
      if (isError(e)) return e;
      const holidays = new Set(a[2] !== undefined ? cells(a[2]).filter((c): c is number => typeof c === "number").map(Math.floor) : []);
      const [lo, hi, sign] = s <= e ? [Math.floor(s), Math.floor(e), 1] : [Math.floor(e), Math.floor(s), -1];
      let n = 0;
      for (let d = lo; d <= hi; d++) {
        const dow = serialToDate(d).dow;
        if (dow !== 0 && dow !== 6 && !holidays.has(d)) n++;
      }
      return n * sign;
    },
  },
};

function dateFn(v: Value, pick: (d: ReturnType<typeof serialToDate>) => number): Value {
  const s = dateArg(v);
  return isError(s) ? s : pick(serialToDate(s));
}

function joinTexts(items: Scalar[], delim: string): Value {
  const out: string[] = [];
  for (const c of items) {
    if (isError(c)) return c;
    out.push(c === null ? "" : typeof c === "number" ? numberToText(c) : (toText(c) as string));
  }
  return out.join(delim);
}

// Array functions spill into the cells beside them; they live in their own module.
Object.assign(FUNCTIONS, ARRAY_FUNCTION_DEFS, MORE_FUNCTION_DEFS, TIME_FUNCTION_DEFS, STAT_FUNCTION_DEFS, { SPLIT: SPLIT_DEF });
FUNCTIONS.SUBTOTAL = subtotalDef(FUNCTIONS);

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();

export type { Grid };
