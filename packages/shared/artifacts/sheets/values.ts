// Cell values and how typed input becomes one. A value is a number, text,
// boolean, error or empty (null). Dates are serial numbers (days since
// 1899-12-30, Excel/Sheets compatible); the cell's format decides how they
// read.
import { ERROR_CODES, type ErrorCode } from "./formula";

const ERROR_LITERALS: readonly ErrorCode[] = ERROR_CODES;

export type SheetError = { error: ErrorCode; message?: string };
export type Scalar = number | string | boolean | SheetError | null;
/** A 2-D block of values: a range read, or an array result. rows[r][c]. */
export type Grid = { grid: Scalar[][] };
export type Value = Scalar | Grid;

export function err(code: ErrorCode, message?: string): SheetError {
  return message ? { error: code, message } : { error: code };
}

export function isError(v: unknown): v is SheetError {
  return !!v && typeof v === "object" && "error" in (v as object);
}

export function isGrid(v: unknown): v is Grid {
  return !!v && typeof v === "object" && "grid" in (v as object);
}

/** Format hints implied by typed input ("10%" reads as a percent, "$5" as currency). */
export type ImpliedFormat = { nf: NumberFormatKind; dp?: number };
export type NumberFormatKind = "number" | "percent" | "currency" | "accounting" | "scientific" | "custom" | "date" | "datetime" | "text" | "plain" | "check";

const DAY_MS = 86_400_000;
const EPOCH_UTC = Date.UTC(1899, 11, 30);

export function dateToSerial(y: number, m: number, d: number): number {
  return (Date.UTC(y, m - 1, d) - EPOCH_UTC) / DAY_MS;
}

export function serialToDate(serial: number): { y: number; m: number; d: number; dow: number; h: number; min: number; s: number } {
  const ms = EPOCH_UTC + Math.round(serial * DAY_MS);
  const dt = new Date(ms);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    dow: dt.getUTCDay(),
    h: dt.getUTCHours(),
    min: dt.getUTCMinutes(),
    s: dt.getUTCSeconds(),
  };
}

/** Today's serial in the local calendar of the machine evaluating. */
export function todaySerial(now = new Date()): number {
  return dateToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function nowSerial(now = new Date()): number {
  return todaySerial(now) + (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parse a date written as text: 2026-11-10, 11/10/2026, Nov 10 2026, 10 Nov 2026. */
export function parseDateText(text: string): number | null {
  const t = text.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return withTime(validDate(+m[1], +m[2], +m[3]), m[4], m[5], m[6]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return validDate(fullYear(+m[3]), +m[1], +m[2]);
  m = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi >= 0) return validDate(+m[3], mi + 1, +m[2]);
  }
  m = t.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    if (mi >= 0) return validDate(+m[3], mi + 1, +m[1]);
  }
  return null;
}

function fullYear(y: number): number {
  return y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y;
}

function validDate(y: number, mo: number, d: number): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const s = dateToSerial(y, mo, d);
  const back = serialToDate(s);
  return back.m === mo && back.d === d ? s : null;
}

function withTime(serial: number | null, h?: string, min?: string, s?: string): number | null {
  if (serial === null || h === undefined) return serial;
  return serial + (Number(h) * 3600 + Number(min) * 60 + Number(s ?? 0)) / 86400;
}

/**
 * What a typed (non-formula) input means: a number, boolean, date, or text.
 * "1,200" -> 1200; "10%" -> 0.1 (percent); "$1,200.50" -> 1200.5 (currency);
 * "2026-11-10" -> serial (date); "'0042" -> text "0042".
 */
export function parseLiteral(input: string): { value: Scalar; implied?: ImpliedFormat } {
  if (input === "") return { value: null };
  if (input[0] === "'") return { value: input.slice(1) };
  const t = input.trim();
  const upper = t.toUpperCase();
  if (upper === "TRUE") return { value: true };
  const code = ERROR_LITERALS.find((c) => c === upper);
  if (code) return { value: err(code) };
  if (upper === "FALSE") return { value: false };
  const num = t.match(/^([+-]?)(\$|€|£)?([+-]?)(\d{1,3}(,\d{3})+|\d*)(\.\d+)?(%?)$/);
  if (num && (num[4] || num[6])) {
    const sign = num[1] === "-" || num[3] === "-" ? -1 : 1;
    const digits = (num[4] || "0").replace(/,/g, "") + (num[6] ?? "");
    let v = sign * Number(digits);
    const dp = num[6] ? num[6].length - 1 : 0;
    if (num[7]) return { value: v / 100, implied: { nf: "percent", dp } };
    if (num[2]) return { value: v, implied: { nf: "currency", dp: dp || (num[6] ? dp : 0) } };
    if (num[4]?.includes(",")) return { value: v, implied: { nf: "number", dp } };
    return { value: v };
  }
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(t)) return { value: Number(t) };
  if (/^\(\$?\d[\d,]*(\.\d+)?\)$/.test(t)) {
    return { value: -Number(t.replace(/[()$,]/g, "")), implied: t.includes("$") ? { nf: "currency" } : undefined };
  }
  const date = parseDateText(t);
  if (date !== null) return { value: date, implied: { nf: Number.isInteger(date) ? "date" : "datetime" } };
  return { value: input };
}

// ── Coercion ────────────────────────────────────────────────────────────────

export function toNumber(v: Scalar): number | SheetError {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (v.trim() === "") return 0;
    const lit = parseLiteral(v).value;
    return typeof lit === "number" ? lit : err("#VALUE!", `"${v}" is not a number`);
  }
  return v;
}

export function toText(v: Scalar): string | SheetError {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return numberToText(v);
  return v;
}

export function numberToText(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = Number(n.toPrecision(15));
  return String(s);
}

export function toBool(v: Scalar): boolean | SheetError {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const u = v.toUpperCase();
    if (u === "TRUE") return true;
    if (u === "FALSE") return false;
    return err("#VALUE!", `"${v}" is not TRUE or FALSE`);
  }
  return v;
}

/** Sheets' ordering for comparisons and sort: numbers < text < booleans; empty sorts last in sort. */
export function compareScalars(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return 0;
}

/** Equality the way = compares: case-insensitive text, empty equals "" and 0. */
export function scalarsEqual(a: Scalar, b: Scalar): boolean {
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
