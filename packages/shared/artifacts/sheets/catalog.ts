// What each formula function takes and does, for people (autocomplete,
// argument hints, the function list) and agents (the guide). Argument names
// ending in "?" are optional; one ending in "..." repeats. A test holds this
// in step with the engine's FUNCTIONS table.
export type FnCategory = "Math" | "Statistics" | "Lookup" | "Array" | "Logic" | "Text" | "Date" | "Info";

export type FnDoc = { args: readonly string[]; about: string; cat: FnCategory };

const d = (cat: FnCategory, about: string, ...args: string[]): FnDoc => ({ args, about, cat });

export const FUNCTION_DOCS: Record<string, FnDoc> = {
  // Math
  SUM: d("Math", "Adds numbers and ranges", "value1", "value2..."),
  SUMIF: d("Math", "Adds the cells that meet a condition", "range", "criterion", "sum_range?"),
  SUMIFS: d("Math", "Adds the cells that meet every condition", "sum_range", "criteria_range1", "criterion1", "more..."),
  SUMPRODUCT: d("Math", "Multiplies ranges item by item and adds the products", "range1", "range2..."),
  PRODUCT: d("Math", "Multiplies numbers and ranges", "value1", "value2..."),
  ROUND: d("Math", "Rounds to a number of decimal places", "value", "places?"),
  ROUNDUP: d("Math", "Rounds away from zero", "value", "places?"),
  ROUNDDOWN: d("Math", "Rounds toward zero", "value", "places?"),
  TRUNC: d("Math", "Cuts off decimals without rounding", "value", "places?"),
  INT: d("Math", "Rounds down to a whole number", "value"),
  CEILING: d("Math", "Rounds up to a multiple", "value", "factor?"),
  FLOOR: d("Math", "Rounds down to a multiple", "value", "factor?"),
  ABS: d("Math", "Absolute value", "value"),
  SIGN: d("Math", "1, 0 or -1 by sign", "value"),
  MOD: d("Math", "Remainder after division", "dividend", "divisor"),
  POWER: d("Math", "A number raised to a power", "base", "exponent"),
  SQRT: d("Math", "Square root", "value"),
  EXP: d("Math", "e raised to a power", "exponent"),
  LN: d("Math", "Natural logarithm", "value"),
  LOG: d("Math", "Logarithm in a base (10 by default)", "value", "base?"),
  LOG10: d("Math", "Base-10 logarithm", "value"),
  PI: d("Math", "The number pi"),
  // Statistics
  AVERAGE: d("Statistics", "Mean of numbers and ranges", "value1", "value2..."),
  AVERAGEIF: d("Statistics", "Mean of the cells that meet a condition", "range", "criterion", "average_range?"),
  AVERAGEIFS: d("Statistics", "Mean of the cells that meet every condition", "average_range", "criteria_range1", "criterion1", "more..."),
  MEDIAN: d("Statistics", "Middle value", "value1", "value2..."),
  MIN: d("Statistics", "Smallest number", "value1", "value2..."),
  MINIFS: d("Statistics", "Smallest number that meets every condition", "range", "criteria_range1", "criterion1", "more..."),
  MAX: d("Statistics", "Largest number", "value1", "value2..."),
  MAXIFS: d("Statistics", "Largest number that meets every condition", "range", "criteria_range1", "criterion1", "more..."),
  COUNT: d("Statistics", "Counts numbers", "value1", "value2..."),
  COUNTA: d("Statistics", "Counts non-empty cells", "value1", "value2..."),
  COUNTBLANK: d("Statistics", "Counts empty cells", "range"),
  COUNTIF: d("Statistics", "Counts the cells that meet a condition", "range", "criterion"),
  COUNTIFS: d("Statistics", "Counts the rows that meet every condition", "criteria_range1", "criterion1", "more..."),
  STDEV: d("Statistics", "Standard deviation of a sample", "value1", "value2..."),
  STDEVP: d("Statistics", "Standard deviation of a population", "value1", "value2..."),
  VAR: d("Statistics", "Variance of a sample", "value1", "value2..."),
  // Lookup
  XLOOKUP: d("Lookup", "Finds a value in one range and returns the matching item from another", "search_key", "lookup_range", "result_range", "if_not_found?", "match_mode?", "search_mode?"),
  VLOOKUP: d("Lookup", "Finds a value in a table's first column and returns a column of that row", "search_key", "range", "column", "is_sorted?"),
  HLOOKUP: d("Lookup", "Finds a value in a table's first row and returns a row of that column", "search_key", "range", "row", "is_sorted?"),
  INDEX: d("Lookup", "The cell at a row and column of a range", "range", "row", "column?"),
  MATCH: d("Lookup", "Position of a value in a range", "search_key", "range", "match_type?"),
  XMATCH: d("Lookup", "Position of a value in a range, exact by default", "search_key", "lookup_range", "match_mode?", "search_mode?"),
  CHOOSE: d("Lookup", "Picks one of several values by number", "index", "choice1", "choice2..."),
  ROWS: d("Lookup", "Number of rows in a range", "range"),
  COLUMNS: d("Lookup", "Number of columns in a range", "range"),
  // Array: the result fills the cells below and to the right
  FILTER: d("Array", "The rows of a range that meet every condition", "range", "condition1", "condition2..."),
  UNIQUE: d("Array", "Each distinct row of a range, once", "range", "by_column?", "exactly_once?"),
  SORT: d("Array", "A range sorted by one of its columns", "range", "sort_column?", "is_ascending?", "by_column?"),
  SORTBY: d("Array", "A range sorted by other ranges", "range", "by_range1", "order1?", "more..."),
  SEQUENCE: d("Array", "A block of numbers counting up", "rows", "columns?", "start?", "step?"),
  TRANSPOSE: d("Array", "A range with rows and columns swapped", "range"),
  SPLIT: d("Array", "A text split into cells side by side", "text", "delimiter", "split_by_each?"),
  COUNTUNIQUE: d("Statistics", "Counts distinct values", "value1", "value2..."),
  RANK: d("Statistics", "A number's rank in a list (1 is the largest)", "value", "range", "is_ascending?"),
  PMT: d("Math", "The payment per period of a loan", "rate", "periods", "present_value", "future_value?", "end_or_beginning?"),
  WORKDAY: d("Date", "The working day some days away, skipping weekends", "start_date", "days", "holidays?"),
  REGEXMATCH: d("Text", "TRUE when a text matches a pattern", "text", "pattern"),
  REGEXEXTRACT: d("Text", "The part of a text a pattern matches", "text", "pattern"),
  REGEXREPLACE: d("Text", "Replaces every match of a pattern", "text", "pattern", "replacement"),
  HYPERLINK: d("Text", "A link, shown as its label", "url", "label?"),
  // Logic
  IF: d("Logic", "One value if a condition is true, another if false", "condition", "if_true", "if_false?"),
  IFS: d("Logic", "The value of the first true condition", "condition1", "value1", "more..."),
  IFERROR: d("Logic", "A fallback when a value is an error", "value", "if_error"),
  IFNA: d("Logic", "A fallback when a value is #N/A", "value", "if_na"),
  SWITCH: d("Logic", "Matches a value against cases", "expression", "case1", "value1", "more..."),
  AND: d("Logic", "TRUE when every condition is true", "condition1", "condition2..."),
  OR: d("Logic", "TRUE when any condition is true", "condition1", "condition2..."),
  XOR: d("Logic", "TRUE when an odd number of conditions are true", "condition1", "condition2..."),
  NOT: d("Logic", "Flips TRUE and FALSE", "condition"),
  TRUE: d("Logic", "The value TRUE"),
  FALSE: d("Logic", "The value FALSE"),
  // Text
  CONCAT: d("Text", "Joins values into one text", "value1", "value2..."),
  CONCATENATE: d("Text", "Joins values into one text", "value1", "value2..."),
  TEXTJOIN: d("Text", "Joins values with a delimiter", "delimiter", "ignore_empty", "value1", "value2..."),
  TEXT: d("Text", "Formats a number as text with a pattern", "value", "format"),
  LEFT: d("Text", "First characters of a text", "text", "count?"),
  RIGHT: d("Text", "Last characters of a text", "text", "count?"),
  MID: d("Text", "Characters from the middle of a text", "text", "start", "count"),
  LEN: d("Text", "Length of a text", "text"),
  FIND: d("Text", "Position of a text inside another, case-sensitive", "search_for", "text", "start?"),
  SEARCH: d("Text", "Position of a text inside another, any case, wildcards allowed", "search_for", "text", "start?"),
  REPLACE: d("Text", "Replaces characters at a position", "text", "start", "count", "new_text"),
  SUBSTITUTE: d("Text", "Replaces one text with another", "text", "search_for", "replace_with", "occurrence?"),
  REPT: d("Text", "Repeats a text", "text", "times"),
  TRIM: d("Text", "Removes extra spaces", "text"),
  UPPER: d("Text", "Upper case", "text"),
  LOWER: d("Text", "Lower case", "text"),
  PROPER: d("Text", "Capitalizes each word", "text"),
  EXACT: d("Text", "TRUE when two texts match exactly", "text1", "text2"),
  VALUE: d("Text", "Reads a text as a number", "text"),
  CHAR: d("Text", "The character for a code", "code"),
  CODE: d("Text", "The code of a text's first character", "text"),
  // Date
  TODAY: d("Date", "Today's date"),
  NOW: d("Date", "The current date and time"),
  DATE: d("Date", "A date from year, month and day", "year", "month", "day"),
  DATEVALUE: d("Date", "Reads a text as a date", "text"),
  YEAR: d("Date", "Year of a date", "date"),
  MONTH: d("Date", "Month of a date (1 to 12)", "date"),
  DAY: d("Date", "Day of the month", "date"),
  WEEKDAY: d("Date", "Day of the week as a number", "date", "type?"),
  HOUR: d("Date", "Hour of a time", "time"),
  MINUTE: d("Date", "Minute of a time", "time"),
  DAYS: d("Date", "Days between two dates", "end_date", "start_date"),
  DATEDIF: d("Date", "Whole days, months or years between dates", "start_date", "end_date", "unit"),
  EDATE: d("Date", "A date some months away", "start_date", "months"),
  EOMONTH: d("Date", "Last day of the month some months away", "start_date", "months"),
  NETWORKDAYS: d("Date", "Working days between two dates", "start_date", "end_date", "holidays?"),
  // Info
  ISBLANK: d("Info", "TRUE when a cell is empty", "value"),
  ISNUMBER: d("Info", "TRUE for a number", "value"),
  ISTEXT: d("Info", "TRUE for text", "value"),
  ISLOGICAL: d("Info", "TRUE for TRUE or FALSE", "value"),
  ISERROR: d("Info", "TRUE for any error", "value"),
  ISERR: d("Info", "TRUE for any error but #N/A", "value"),
  ISNA: d("Info", "TRUE for #N/A", "value"),
  NA: d("Info", "The #N/A error"),
};

export const FN_CATEGORIES: readonly FnCategory[] = ["Math", "Statistics", "Lookup", "Array", "Logic", "Text", "Date", "Info"];

/** "XLOOKUP(search_key, lookup_range, result_range, [if_not_found], …)" */
export function fnSignature(name: string): string {
  const doc = FUNCTION_DOCS[name];
  if (!doc) return `${name}()`;
  return `${name}(${doc.args.map(argLabel).join(", ")})`;
}

export function argLabel(arg: string): string {
  if (arg === "more...") return "…";
  if (arg.endsWith("?")) return `[${arg.slice(0, -1)}]`;
  if (arg.endsWith("...")) return `${arg.slice(0, -3)}, …`;
  return arg;
}

/**
 * The argument a caret index falls on: a repeating tail ("value2...", or the
 * "criteria_range1, criterion1, more..." pair) wraps so the hint follows the
 * caret through any number of arguments.
 */
export function argIndexFor(name: string, index: number): number {
  const doc = FUNCTION_DOCS[name];
  if (!doc || doc.args.length === 0) return -1;
  const last = doc.args.length - 1;
  const tail = doc.args[last];
  if (index < last || (index === last && tail !== "more...")) return index;
  if (tail === "more...") {
    // Pairs before "more...": cycle through them.
    const firstPair = doc.args.findIndex((a) => /1$/.test(a));
    const span = last - firstPair;
    return span > 0 ? firstPair + ((index - firstPair) % span) : last;
  }
  return tail.endsWith("...") ? last : -1;
}

/**
 * The function call the caret sits inside, and which argument: for
 * "=ROUND(SUM(A1:A4), |" it is { name: "ROUND", arg: 1 }. Strings and quoted
 * tab names do not count; null outside any call.
 */
export function callAt(text: string, caret: number): { name: string; arg: number } | null {
  if (!text.startsWith("=")) return null;
  const stack: Array<{ name: string; arg: number }> = [];
  let i = 1;
  const upto = Math.min(caret, text.length);
  while (i < upto) {
    const ch = text[i];
    if (ch === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0 || close >= upto) return stack.at(-1) ?? null;
      i = close + 1;
      continue;
    }
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0 || close >= upto) return null;
      i = close + 1;
      continue;
    }
    if (ch === "(") {
      const m = text.slice(0, i).match(/([A-Za-z][A-Za-z0-9.]*)\s*$/);
      stack.push({ name: m ? m[1].toUpperCase() : "", arg: 0 });
    } else if (ch === ")") stack.pop();
    else if (ch === "," && stack.length) stack[stack.length - 1].arg++;
    i++;
  }
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name) return stack[k];
  return null;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type ErrorDoc = { title: string; fix: string };

/** What each error code means and the usual fix, for the error card. */
export const ERROR_DOCS: Record<string, ErrorDoc> = {
  "#DIV/0!": { title: "Divided by zero", fix: "Wrap it: =IFERROR(formula, 0), or check the divisor isn't blank" },
  "#N/A": { title: "Value not found", fix: "Check the lookup value exists, or wrap it: =IFNA(formula, \"\")" },
  "#NAME?": { title: "Unknown name", fix: "Check the function's spelling, and put text in quotes" },
  "#REF!": { title: "Reference is gone", fix: "A row, column or tab it pointed at was deleted. Retype the reference" },
  "#VALUE!": { title: "Wrong kind of value", fix: "An argument is text where a number or date belongs" },
  "#NUM!": { title: "Number out of range", fix: "The result is too big, or an argument is outside what the function accepts" },
  "#CIRC!": { title: "Circular reference", fix: "The formula depends on its own cell. Point it elsewhere" },
  "#SPILL!": { title: "No room for the result", fix: "Clear the cells below and to the right of the formula; its result fills them" },
  "#NULL!": { title: "Ranges don't meet", fix: "Separate ranges with a comma, not a space" },
  "#ERROR!": { title: "Formula can't be read", fix: "Check the parentheses, commas and quotes" },
};

/** A corrected function name for a #NAME? typo ("SUMM" → "SUM"), when one is close. */
export function nearestFunction(name: string, names: readonly string[]): string | null {
  const want = name.toUpperCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of names) {
    const dist = editDistance(want, n);
    if (dist < bestD) {
      bestD = dist;
      best = n;
    }
  }
  return best && bestD <= Math.max(1, Math.floor(want.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/**
 * A one-step fix for an error, as the formula to put in the cell: the closest
 * function for a misspelled one, IFERROR / IFNA around a formula that divides
 * by zero or finds nothing. Null when no fix is safe to offer.
 */
export function errorFix(code: string, message: string | undefined, input: string): { label: string; text: string } | null {
  if (!input.startsWith("=")) return null;
  const body = input.slice(1);
  if (code === "#NAME?") {
    const m = message?.match(/^unknown function (\S+)/);
    if (!m) return null;
    const near = nearestFunction(m[1], Object.keys(FUNCTION_DOCS));
    if (!near) return null;
    const re = new RegExp(`(^|[^A-Za-z0-9_.])${m[1].replace(/\./g, "\\.")}\\s*\\(`, "i");
    return { label: `Use ${near}`, text: "=" + body.replace(re, (_s, pre: string) => `${pre}${near}(`) };
  }
  if (code === "#DIV/0!" && !/^IFERROR\(/i.test(body)) return { label: "Show 0 instead", text: `=IFERROR(${body}, 0)` };
  if (code === "#N/A" && !/^IF(NA|ERROR)\(/i.test(body)) return { label: "Show blank instead", text: `=IFNA(${body}, "")` };
  return null;
}

/** "#DIV/0! division by zero" → the code and the engine's message. */
export function splitError(text: string): { code: string; message?: string } {
  const sp = text.indexOf(" ");
  return sp < 0 ? { code: text } : { code: text.slice(0, sp), message: text.slice(sp + 1) };
}

/** The functions people reach for most, most used first: autocomplete offers these ahead of rarer names ("SU" -> SUM, not SUBSTITUTE). */
const COMMON = ["SUM", "IF", "COUNT", "AVERAGE", "COUNTIF", "SUMIF", "VLOOKUP", "XLOOKUP", "COUNTA", "MAX", "MIN", "ROUND", "IFERROR", "INDEX", "MATCH", "SUMIFS", "COUNTIFS", "AND", "OR", "TODAY", "TEXT", "LEFT", "RIGHT", "MID", "LEN", "CONCAT", "DATE", "YEAR", "MONTH", "AVERAGEIF", "SUMPRODUCT", "ABS", "TRIM", "UPPER", "LOWER", "NOW", "IFS", "TEXTJOIN", "EOMONTH", "EDATE", "NETWORKDAYS", "MEDIAN"];
const COMMON_RANK = new Map(COMMON.map((n, i) => [n, i]));

/** Function names starting with a prefix, common ones first, then alphabetical. */
export function functionMatches(prefix: string, names: readonly string[], limit = 8): string[] {
  const p = prefix.toUpperCase();
  return names
    .filter((n) => n.startsWith(p))
    .sort((a, b) => (COMMON_RANK.get(a) ?? 999) - (COMMON_RANK.get(b) ?? 999) || a.localeCompare(b))
    .slice(0, limit);
}

/** The usual fix for an error, sharpened by what the engine said ("no tab named X" is a typo, not a deletion). */
export function errorHint(code: string, message?: string): string | undefined {
  if (message?.startsWith("no tab named")) return "No tab has that name. Check its spelling, and quote names with spaces: 'Q4 plan'!A1";
  if (message?.startsWith("unknown name")) return "Put text in quotes, or check the name's spelling";
  return ERROR_DOCS[code]?.fix;
}

/** What the current argument wants, for the functions people use most (the hint shows it under the signature). */
export const ARG_HELP: Record<string, Record<string, string>> = {
  IF: { condition: "A test that is TRUE or FALSE, like B2>100", if_true: "What to show when the test is TRUE", if_false: "What to show otherwise (blank if left out)" },
  SUMIF: { range: "The cells to test", criterion: 'The test, like ">100", "Done" or "a*"', sum_range: "The cells to add (the tested ones if left out)" },
  SUMIFS: { sum_range: "The cells to add", criteria_range1: "Cells to test", criterion1: 'Their test, like ">100" or "Done"' },
  COUNTIF: { range: "The cells to test", criterion: 'The test, like ">100", "Done" or "a*"' },
  COUNTIFS: { criteria_range1: "Cells to test", criterion1: 'Their test, like ">100" or "Done"' },
  VLOOKUP: { search_key: "The value to find in the table's first column", range: "The table, first column included", column: "Which column of the table to return (1 is the first)", is_sorted: "FALSE for an exact match (the usual choice)" },
  XLOOKUP: { search_key: "The value to find", lookup_range: "Where to find it (one column or row)", result_range: "What to return from the same position", if_not_found: "Shown when nothing matches (#N/A otherwise)" },
  INDEX: { range: "The table", row: "Which row of it (1 is the first)", column: "Which column of it" },
  MATCH: { search_key: "The value to find", range: "One row or column to search", match_type: "0 for an exact match" },
  ROUND: { value: "The number to round", places: "Decimal places to keep (0 if left out; negative rounds to tens, hundreds)" },
  IFERROR: { value: "The formula that may fail", if_error: "What to show instead of the error" },
  TEXT: { value: "The number or date", format: 'A format code, like "0.0%", "$#,##0" or "mmm d"' },
  DATE: { year: "Four-digit year", month: "1 to 12 (13 rolls into next year)", day: "Day of the month" },
  FILTER: { range: "The rows to choose from", condition1: 'A column of TRUE/FALSE as tall as the range, like C2:C99="Open"' },
  UNIQUE: { range: "The values to list once each", by_column: "TRUE to compare columns instead of rows", exactly_once: "TRUE to keep only values that appear once" },
  SORT: { range: "The rows to sort", sort_column: "Which column of the range to sort by (1 is the first)", is_ascending: "TRUE for A to Z, FALSE for Z to A" },
  EDATE: { start_date: "The date to start from", months: "Months later (negative for earlier)" },
  TEXTJOIN: { delimiter: 'What goes between the parts, like ", "', ignore_empty: "TRUE to skip blank cells" },
};

/** The help line for one argument of a call ("The cells to test"), when known. */
export function argHelp(name: string, argIndex: number): string | undefined {
  const arg = FUNCTION_DOCS[name]?.args[argIndex];
  return arg ? ARG_HELP[name]?.[arg.replace(/[?.]+$/, "")] : undefined;
}
