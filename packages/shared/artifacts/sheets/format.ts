// How a value reads in a cell: the cell's number format (number, percent,
// currency, date, ...) with its decimals and sign, or a TEXT() format code.
import { isError, serialToDate, numberToText, type NumberFormatKind, type Scalar, type ImpliedFormat } from "./values";

export type CellNumberFormat = {
  nf?: NumberFormatKind;
  /** Decimal places; default depends on the kind. */
  dp?: number;
  /** Show a + on positive numbers ("+10%", "+4,213"). */
  sign?: boolean;
  /** Currency symbol, default "$". */
  cur?: string;
  /** A custom format code (nf "custom"), the TEXT() codes: "#,##0.0 \"kg\"", "0.00%", "mmm d". */
  code?: string;
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 1234.5 -> "1,234.50" with dp=2. Rounds half away from zero. */
export function formatFixed(n: number, dp: number, group = true): string {
  const neg = n < 0;
  const abs = Math.abs(n);
  const factor = 10 ** dp;
  const rounded = Math.round((abs + Number.EPSILON * abs) * factor) / factor;
  const [i, f] = rounded.toFixed(dp).split(".");
  const body = (group ? groupThousands(i) : i) + (f ? `.${f}` : "");
  return (neg && rounded !== 0 ? "-" : "") + body;
}

export function formatDate(serial: number, withTime = false): string {
  const d = serialToDate(serial);
  const base = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  return withTime ? `${base} ${String(d.h).padStart(2, "0")}:${String(d.min).padStart(2, "0")}` : base;
}

/** Plain display of a number with no format: up to 10 significant decimals, no grouping. */
function plainNumber(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-9 && n !== 0)) return n.toExponential(4).replace("e+", "E+").replace("e-", "E-");
  return numberToText(Number(n.toPrecision(12)));
}

/** The text a cell shows for its value. */
export function formatValue(v: Scalar, fmt: CellNumberFormat | undefined, implied?: ImpliedFormat): string {
  // A checkbox cell reads TRUE/FALSE (or 1/0, or empty) as a box.
  if (fmt?.nf === "check" && !isError(v)) return v === true || v === 1 || (typeof v === "string" && v.toUpperCase() === "TRUE") ? "☑" : "☐";
  if (v === null) return "";
  if (isError(v)) return v.error;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v;
  const kind = fmt?.nf ?? implied?.nf;
  const dp = fmt?.dp ?? (fmt?.nf ? undefined : implied?.dp);
  const plus = fmt?.sign && v > 0 ? "+" : "";
  switch (kind) {
    case "number":
      return plus + formatFixed(v, dp ?? 0);
    case "percent":
      return plus + formatFixed(v * 100, dp ?? 0) + "%";
    case "currency": {
      const sym = fmt?.cur ?? "$";
      const body = formatFixed(Math.abs(v), dp ?? 2);
      return (v < 0 ? "-" : plus) + sym + body;
    }
    case "accounting": {
      // Negatives in parentheses, the symbol kept apart from the digits, as ledgers show money.
      const sym = fmt?.cur ?? "$";
      const body = formatFixed(Math.abs(v), dp ?? 2);
      return v < 0 ? `(${sym}${body})` : `${sym}${body}`;
    }
    case "scientific":
      return plus + v.toExponential(dp ?? 2).toUpperCase().replace(/E\+?(-?)(\d)$/, "E+$10$2").replace("E+-", "E-");
    case "custom":
      return fmt?.code ? formatWithCode(v, fmt.code) : plainNumber(v);
    case "date":
      return formatDate(v);
    case "datetime":
      return formatDate(v, true);
    case "text":
      return plainNumber(v);
    default:
      return plus + (dp !== undefined ? formatFixed(v, dp, false) : plainNumber(v));
  }
}

/** Whether a value reads right-aligned by default (numbers, dates). */
export function isNumericValue(v: Scalar): boolean {
  return typeof v === "number";
}

/**
 * TEXT(value, format_text): the common Excel/Sheets format codes.
 * Numbers: 0, 0.00, #,##0, #,##0.00, 0%, 0.0%, $#,##0, 0.00E+00.
 * Dates: yyyy yy mmmm mmm mm m dddd ddd dd d hh h mm(min) ss AM/PM.
 */
export function formatWithCode(v: number, code: string): string {
  const section = code.split(";")[v < 0 && code.includes(";") ? 1 : 0] ?? code;
  const useAbs = v < 0 && code.includes(";");
  const n = useAbs ? Math.abs(v) : v;
  if (/[ymdhs]/i.test(section.replace(/"[^"]*"/g, "")) && !/[0#]/.test(section)) return formatDateCode(n, section);
  const literalPrefix = section.match(/^[^0#.,%]*/)?.[0] ?? "";
  const literalSuffix = section.match(/[^0#.,%]*$/)?.[0] ?? "";
  const core = section.slice(literalPrefix.length, section.length - literalSuffix.length);
  const percent = section.includes("%");
  const scaled = percent ? n * 100 : n;
  if (/E\+/i.test(core)) {
    const dp = (core.split(".")[1] ?? "").replace(/E.*/i, "").length;
    return strip(literalPrefix) + scaled.toExponential(dp).toUpperCase().replace(/E\+?(-?)(\d)$/, "E+$10$2") + strip(literalSuffix);
  }
  const [intSpec, decSpec = ""] = core.replace(/%/g, "").split(".");
  const dp = decSpec.replace(/[^0#]/g, "").length;
  const group = intSpec.includes(",");
  let body = formatFixed(scaled, dp, group);
  // Optional decimals (#): trim trailing zeros past the 0 placeholders.
  const minDp = decSpec.replace(/[^0]/g, "").length;
  if (dp > minDp && body.includes(".")) {
    let [i, f] = body.split(".");
    while (f.length > minDp && f.endsWith("0")) f = f.slice(0, -1);
    body = f ? `${i}.${f}` : i;
  }
  const minInt = intSpec.replace(/[^0]/g, "").length;
  if (minInt === 0 && /^-?0(\.|$)/.test(body) && dp > 0) body = body.replace(/^(-?)0\./, "$1.");
  return strip(literalPrefix) + body + (percent ? "%" : "") + strip(literalSuffix.replace(/%/g, ""));
}

function strip(s: string): string {
  return s.replace(/"/g, "").replace(/\\(.)/g, "$1");
}

function formatDateCode(serial: number, code: string): string {
  const d = serialToDate(serial);
  const ampm = /AM\/PM/i.test(code);
  const tokens = code.match(/"[^"]*"|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|./gi) ?? [];
  let out = "";
  let lastWasHour = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    const nextIsSecond = tokens.slice(i + 1).find((x) => /[a-z]/i.test(x))?.toLowerCase().startsWith("s");
    if (t.startsWith('"')) out += t.slice(1, -1);
    else if (lower === "yyyy") out += d.y;
    else if (lower === "yy") out += String(d.y).slice(-2);
    else if (lower === "mmmm") out += MONTHS_LONG[d.m - 1];
    else if (lower === "mmm") out += MONTHS_SHORT[d.m - 1];
    else if (lower === "mm" || lower === "m") {
      const minute = lastWasHour || nextIsSecond;
      const n = minute ? d.min : d.m;
      out += lower === "mm" ? String(n).padStart(2, "0") : String(n);
    } else if (lower === "dddd") out += DAYS_LONG[d.dow];
    else if (lower === "ddd") out += DAYS_SHORT[d.dow];
    else if (lower === "dd") out += String(d.d).padStart(2, "0");
    else if (lower === "d") out += String(d.d);
    else if (lower === "hh" || lower === "h") {
      const h = ampm ? ((d.h + 11) % 12) + 1 : d.h;
      out += lower === "hh" ? String(h).padStart(2, "0") : String(h);
    } else if (lower === "ss") out += String(d.s).padStart(2, "0");
    else if (lower === "s") out += String(d.s);
    else if (lower === "am/pm") out += d.h < 12 ? "AM" : "PM";
    else out += t;
    if (/^h+$/.test(lower)) lastWasHour = true;
    else if (/[a-z]/i.test(t)) lastWasHour = false;
  }
  return out;
}
