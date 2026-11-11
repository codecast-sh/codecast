// Everyday functions beyond the core table: counting distinct values, rank,
// loan payments, working days ahead, regular expressions, links. Kept apart
// from functions.ts so neither file grows past a read.
import { dateToSerial, err, isError, isGrid, parseTimeText, serialToDate, toNumber, toText, type Scalar, type Value } from "./values";
import { cells, dateArg, scalarOf } from "./functionArgs";
import type { FnDef } from "./functions";

function textArg(v: Value): string | Scalar {
  const t = toText(scalarOf(v));
  return t;
}

function regexArg(v: Value): RegExp | Scalar {
  const p = textArg(v);
  if (isError(p)) return p;
  try {
    return new RegExp(p as string);
  } catch {
    return err("#VALUE!", `"${p}" is not a valid pattern`);
  }
}

export const MORE_FUNCTION_DEFS: Record<string, FnDef> = {
  COUNTUNIQUE: {
    min: 1,
    eager: (args) => {
      const seen = new Set<string>();
      for (const a of args) for (const c of cells(a)) if (c !== null && c !== "" && !isError(c)) seen.add(`${typeof c}:${typeof c === "string" ? c.toLowerCase() : String(c)}`);
      return seen.size;
    },
  },
  RANK: {
    min: 2,
    max: 3,
    eager: ([value, range, ascArg]) => {
      const v = toNumber(scalarOf(value));
      if (isError(v)) return v;
      const asc = ascArg !== undefined && toNumber(scalarOf(ascArg)) === 1;
      const nums = cells(range).filter((c): c is number => typeof c === "number");
      if (!nums.includes(v)) return err("#N/A", "the value isn't in the range");
      return 1 + nums.filter((n) => (asc ? n < v : n > v)).length;
    },
  },
  PMT: {
    min: 3,
    max: 5,
    eager: (a) => {
      const [rate, nper, pv, fv = 0, type = 0] = a.map((x) => toNumber(scalarOf(x)));
      for (const x of [rate, nper, pv, fv, type]) if (isError(x)) return x;
      const [r, n, p, f, t] = [rate, nper, pv, fv, type] as number[];
      if (n === 0) return err("#NUM!", "the number of payments is zero");
      if (r === 0) return -(p + f) / n;
      const g = (1 + r) ** n;
      return -(r * (p * g + f)) / ((1 + r * t) * (g - 1));
    },
  },
  WORKDAY: {
    min: 2,
    max: 3,
    eager: (a) => {
      const start = dateArg(a[0]);
      const days = toNumber(scalarOf(a[1]));
      if (isError(start)) return start;
      if (isError(days)) return days;
      const holidays = new Set(a[2] !== undefined ? cells(a[2]).filter((c): c is number => typeof c === "number").map(Math.floor) : []);
      let d = Math.floor(start);
      let left = Math.trunc(days);
      const step = left < 0 ? -1 : 1;
      while (left !== 0) {
        d += step;
        const dow = serialToDate(d).dow;
        if (dow !== 0 && dow !== 6 && !holidays.has(d)) left -= step;
      }
      return d;
    },
  },
  REGEXMATCH: {
    min: 2,
    max: 2,
    eager: ([text, pattern]) => {
      const t = textArg(text), re = regexArg(pattern);
      if (isError(t)) return t;
      if (!(re instanceof RegExp)) return re;
      return re.test(t as string);
    },
  },
  REGEXEXTRACT: {
    min: 2,
    max: 2,
    eager: ([text, pattern]) => {
      const t = textArg(text), re = regexArg(pattern);
      if (isError(t)) return t;
      if (!(re instanceof RegExp)) return re;
      const m = (t as string).match(re);
      if (!m) return err("#N/A", "no match");
      return m[1] ?? m[0];
    },
  },
  REGEXREPLACE: {
    min: 3,
    max: 3,
    eager: ([text, pattern, replacement]) => {
      const t = textArg(text), re = regexArg(pattern), r = textArg(replacement);
      if (isError(t)) return t;
      if (isError(r)) return r;
      if (!(re instanceof RegExp)) return re;
      return (t as string).replace(new RegExp(re.source, "g"), r as string);
    },
  },
  HYPERLINK: {
    min: 1,
    max: 2,
    // A link reads as its label (or the address); the grid shows the text.
    eager: ([url, label]) => {
      const t = textArg(label ?? url);
      return isError(t) ? t : (t as string);
    },
  },
};

/** SPLIT(text, delimiter): the pieces side by side. It spills, so it lives with the array functions' engine handling. */
export const SPLIT_DEF: FnDef = {
  min: 2,
  max: 3,
  eager: ([text, delim, eachArg]) => {
    const t = textArg(text), d = textArg(delim);
    if (isError(t)) return t;
    if (isError(d)) return d;
    // Like Sheets, each character of the delimiter splits unless split_by_each is FALSE.
    const each = eachArg === undefined || isGrid(eachArg) || scalarOf(eachArg) !== false;
    const parts = each && (d as string).length > 1 ? (t as string).split(new RegExp(`[${(d as string).replace(/[\]\\^-]/g, "\\$&")}]`)) : (t as string).split(d as string);
    const kept = parts.filter((p) => p !== "");
    return { grid: [kept.map((p) => (p.trim() !== "" && !Number.isNaN(Number(p)) ? Number(p) : p))] };
  },
};

/** TIME and TIMEVALUE: a time of day as the fraction of a day the sheet adds and formats. */
export const TIME_FUNCTION_DEFS: Record<string, FnDef> = {
  TIME: {
    min: 3,
    max: 3,
    eager: (a) => {
      const [h, m, s] = a.map((x) => toNumber(scalarOf(x)));
      for (const x of [h, m, s]) if (isError(x)) return x;
      const v = ((h as number) * 3600 + (m as number) * 60 + (s as number)) / 86400;
      return v < 0 ? err("#NUM!", "a time can't be negative") : v - Math.floor(v);
    },
  },
  TIMEVALUE: {
    min: 1,
    max: 1,
    eager: ([text]) => {
      const t = textArg(text);
      if (isError(t)) return t;
      const v = parseTimeText(t as string);
      return v === null ? err("#VALUE!", `"${t}" is not a time`) : v - Math.floor(v);
    },
  },
};

function numbersIn(v: Value): number[] {
  return cells(v).filter((c): c is number => typeof c === "number");
}

function kthArg(args: Value[]): { ns: number[]; k: number } | Scalar {
  const ns = numbersIn(args[0]);
  const k = toNumber(scalarOf(args[1]));
  if (isError(k)) return k;
  if (k < 1 || k > ns.length) return err("#NUM!", `k is outside 1..${ns.length}`);
  return { ns, k: Math.floor(k) };
}

/** ISO week: weeks start Monday; week 1 holds the year's first Thursday. */
function isoWeek(serial: number): number {
  const day = Math.floor(serial);
  const thursday = day - ((serialToDate(day).dow + 6) % 7) + 3;
  return Math.floor((thursday - dateToSerial(serialToDate(thursday).y, 1, 1)) / 7) + 1;
}

function dayOfYear(serial: number): number {
  const day = Math.floor(serial);
  return day - dateToSerial(serialToDate(day).y, 1, 1) + 1;
}

/** SUBTOTAL's function codes (1-11, and 101-111 which Excel also uses to skip hidden rows). */
const SUBTOTAL_FNS: Record<number, string> = { 1: "AVERAGE", 2: "COUNT", 3: "COUNTA", 4: "MAX", 5: "MIN", 6: "PRODUCT", 7: "STDEV", 8: "STDEVP", 9: "SUM", 10: "VAR", 11: "VARP" };

export const STAT_FUNCTION_DEFS: Record<string, FnDef> = {
  IRR: {
    min: 1,
    max: 2,
    eager: ([range, guessArg]) => {
      const flows = numbersIn(range);
      const guess = guessArg === undefined ? 0.1 : toNumber(scalarOf(guessArg));
      if (isError(guess)) return guess;
      if (!flows.some((f) => f > 0) || !flows.some((f) => f < 0)) return err("#NUM!", "cash flows need at least one payment and one receipt");
      // Newton's method on the net present value, as Excel does, from the guess.
      let r = guess;
      for (let i = 0; i < 100; i++) {
        let npv = 0, d = 0;
        flows.forEach((f, t) => {
          npv += f / (1 + r) ** t;
          d -= (t * f) / (1 + r) ** (t + 1);
        });
        if (!d) break;
        const next = r - npv / d;
        if (!Number.isFinite(next)) break;
        if (Math.abs(next - r) < 1e-10) return next;
        r = next;
      }
      return err("#NUM!", "no rate found; try a guess");
    },
  },
  ADDRESS: {
    min: 2,
    max: 5,
    eager: ([rowArg, colArg, absArg, a1Arg, sheetArg]) => {
      const [row, col, abs] = [rowArg, colArg, absArg ?? 1].map((x) => toNumber(scalarOf(x)));
      for (const n of [row, col, abs]) if (isError(n)) return n;
      if ((row as number) < 1 || (col as number) < 1) return err("#VALUE!", "row and column start at 1");
      const r1c1 = a1Arg !== undefined && scalarOf(a1Arg) === false;
      const rAbs = abs === 1 || abs === 2, cAbs = abs === 1 || abs === 3;
      let colText = "";
      for (let n = col as number; n > 0; n = Math.floor((n - 1) / 26)) colText = String.fromCharCode(65 + ((n - 1) % 26)) + colText;
      const ref = r1c1 ? `R${rAbs ? row : `[${row}]`}C${cAbs ? col : `[${col}]`}` : `${cAbs ? "$" : ""}${colText}${rAbs ? "$" : ""}${row}`;
      const sheet = sheetArg === undefined ? "" : textArg(sheetArg);
      if (typeof sheet !== "string") return sheet;
      return sheet ? `${/^[A-Za-z_][\w.]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`}!${ref}` : ref;
    },
  },
  FORECAST: {
    min: 3,
    max: 3,
    eager: ([xArg, ysArg, xsArg]) => {
      const x = toNumber(scalarOf(xArg));
      if (isError(x)) return x;
      const ys = cells(ysArg), xs = cells(xsArg);
      if (ys.length !== xs.length) return err("#N/A", "the known y and x ranges differ in size");
      const pairs = ys.map((y, i) => [xs[i], y]).filter((p): p is [number, number] => typeof p[0] === "number" && typeof p[1] === "number");
      if (pairs.length < 2) return err("#DIV/0!", "needs at least two points");
      const mx = pairs.reduce((a, p) => a + p[0], 0) / pairs.length, my = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
      const sxx = pairs.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
      if (!sxx) return err("#DIV/0!", "the known x values are all the same");
      const slope = pairs.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx;
      return my + slope * (x - mx);
    },
  },
  LARGE: { min: 2, max: 2, eager: (a) => { const r = kthArg(a); return r && typeof r === "object" && "ns" in r ? [...r.ns].sort((x, y) => y - x)[r.k - 1] : (r as Scalar); } },
  SMALL: { min: 2, max: 2, eager: (a) => { const r = kthArg(a); return r && typeof r === "object" && "ns" in r ? [...r.ns].sort((x, y) => x - y)[r.k - 1] : (r as Scalar); } },
  PERCENTILE: {
    min: 2,
    max: 2,
    eager: ([range, kArg]) => {
      const ns = numbersIn(range).sort((x, y) => x - y);
      const k = toNumber(scalarOf(kArg));
      if (isError(k)) return k;
      if (!ns.length || k < 0 || k > 1) return err("#NUM!", "k must be between 0 and 1");
      const pos = k * (ns.length - 1), lo = Math.floor(pos);
      return ns[lo] + (ns[Math.min(lo + 1, ns.length - 1)] - ns[lo]) * (pos - lo);
    },
  },
  MROUND: {
    min: 2,
    max: 2,
    eager: (a) => {
      const [v, m] = a.map((x) => toNumber(scalarOf(x)));
      if (isError(v)) return v;
      if (isError(m)) return m;
      if (m === 0) return 0;
      if (Math.sign(v) * Math.sign(m) < 0) return err("#NUM!", "the value and the multiple need the same sign");
      return Math.round(v / m) * m;
    },
  },
  WEEKNUM: {
    min: 1,
    max: 2,
    eager: ([date, typeArg]) => {
      const s = dateArg(date);
      if (isError(s)) return s;
      const type = typeArg === undefined ? 1 : toNumber(scalarOf(typeArg));
      if (isError(type)) return type;
      if (type === 21) return isoWeek(s);
      // Week 1 holds January 1st; weeks start Sunday (1) or Monday (2).
      const start = type === 2 ? 1 : 0;
      const doy = dayOfYear(s);
      const jan1dow = (serialToDate(Math.floor(s) - doy + 1).dow - start + 7) % 7;
      return Math.floor((doy - 1 + jan1dow) / 7) + 1;
    },
  },
  ISOWEEKNUM: { min: 1, max: 1, eager: ([date]) => { const s = dateArg(date); return isError(s) ? s : isoWeek(s); } },
  RANDBETWEEN: {
    min: 2,
    max: 2,
    eager: (a) => {
      const [lo, hi] = a.map((x) => toNumber(scalarOf(x)));
      if (isError(lo)) return lo;
      if (isError(hi)) return hi;
      const l = Math.ceil(lo), h = Math.floor(hi);
      return h < l ? err("#NUM!", "the bottom is above the top") : l + Math.floor(Math.random() * (h - l + 1));
    },
  },
  FV: {
    min: 3,
    max: 5,
    eager: (a) => {
      const [rate, nper, pmt, pv = 0, type = 0] = a.map((x) => toNumber(scalarOf(x)));
      for (const x of [rate, nper, pmt, pv, type]) if (isError(x)) return x;
      const [r, n, p, v, t] = [rate, nper, pmt, pv, type] as number[];
      if (r === 0) return -(v + p * n);
      const g = (1 + r) ** n;
      return -(v * g + (p * (1 + r * t) * (g - 1)) / r);
    },
  },
  NPV: {
    min: 2,
    eager: ([rateArg, ...flows]) => {
      const r = toNumber(scalarOf(rateArg));
      if (isError(r)) return r;
      let i = 0;
      let total = 0;
      for (const f of flows) for (const c of numbersIn(f)) total += c / (1 + r) ** ++i;
      return total;
    },
  },
  CORREL: {
    min: 2,
    max: 2,
    eager: ([a, b]) => {
      const xs = cells(a), ys = cells(b);
      if (xs.length !== ys.length) return err("#N/A", "the ranges differ in size");
      const pairs = xs.map((x, i) => [x, ys[i]]).filter((p): p is [number, number] => typeof p[0] === "number" && typeof p[1] === "number");
      const n = pairs.length;
      if (n < 2) return err("#DIV/0!", "needs two pairs of numbers");
      const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      for (const [x, y] of pairs) {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx) ** 2;
        syy += (y - my) ** 2;
      }
      return sxx && syy ? sxy / Math.sqrt(sxx * syy) : err("#DIV/0!", "a range has no spread");
    },
  },
};

/** SUBTOTAL(code, range...): the named aggregate. Lives beside FUNCTIONS, which it calls. */
export function subtotalDef(fns: Record<string, FnDef>): FnDef {
  return {
    min: 2,
    eager: ([codeArg, ...ranges], ctx) => {
      const code = toNumber(scalarOf(codeArg));
      if (isError(code)) return code;
      const name = SUBTOTAL_FNS[code > 100 ? code - 100 : code];
      const fn = name ? fns[name]?.eager : undefined;
      return fn ? fn(ranges, ctx) : err("#VALUE!", "the code must be 1 to 11 or 101 to 111");
    },
  };
}
