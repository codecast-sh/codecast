// Everyday functions beyond the core table: counting distinct values, rank,
// loan payments, working days ahead, regular expressions, links. Kept apart
// from functions.ts so neither file grows past a read.
import { err, isError, isGrid, serialToDate, toNumber, toText, type Scalar, type Value } from "./values";
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
