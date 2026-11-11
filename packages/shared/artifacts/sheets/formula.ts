// Formula parsing: text after "=" -> tokens (with source positions, so
// references can be rewritten in place) -> AST. Excel/Sheets syntax:
// arithmetic, comparison, & concatenation, % postfix, function calls, cell
// and range references with $ anchors, whole columns (A:C) and rows (2:5),
// and tab-qualified references (Historical!B2, 'Q4 plan'!A1:B9).

export const MAX_ROW = 1_000_000;
export const MAX_COL = 18_278; // ZZZ

export type RefPart = { col: number; row: number; absCol: boolean; absRow: boolean };

export type RefToken = {
  type: "ref";
  /** Tab name as written, unquoted; undefined means the formula's own tab. */
  tab?: string;
  /** cell: a only. range: a:b. cols: A:C (rows unbounded). rows: 2:5 (cols unbounded). */
  /** colsFrom: an open-ended column range from a cell down, "A2:A" (b sits on the last row). */
  /** spill: a cell's whole spilled block, "E1#". */
  shape: "cell" | "range" | "cols" | "rows" | "colsFrom" | "spill";
  a: RefPart;
  b?: RefPart;
  start: number;
  end: number;
};

export type Token =
  | { type: "num"; v: number; start: number; end: number }
  | { type: "str"; v: string; start: number; end: number }
  | { type: "bool"; v: boolean; start: number; end: number }
  | { type: "err"; v: string; start: number; end: number }
  | { type: "fn"; v: string; start: number; end: number }
  | { type: "name"; v: string; start: number; end: number }
  | { type: "op"; v: string; start: number; end: number }
  | RefToken;

export const ERROR_CODES = ["#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#REF!", "#VALUE!", "#CIRC!", "#SPILL!", "#ERROR!"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const SHEET_PREFIX = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!`;
const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})`;
const RE_CELL_RANGE = new RegExp(`^(?:${SHEET_PREFIX})?${CELL}(?::${CELL})?(?![A-Za-z0-9_(])`);
const RE_COLS = new RegExp(String.raw`^(?:${SHEET_PREFIX})?(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])`);
const RE_COLS_FROM = new RegExp(String.raw`^(?:${SHEET_PREFIX})?${CELL}:(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])`);
const RE_ROWS = new RegExp(String.raw`^(?:${SHEET_PREFIX})?(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![A-Za-z0-9_(])`);
const RE_NUM = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;
const RE_IDENT = /^[A-Za-z_][A-Za-z0-9_.]*/;

function colIdx(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export class FormulaSyntaxError extends Error {}

/** Tokenize formula text (without the leading "="). Positions index into `src`. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  /** Inside an array constant ({1,2;3,4}) a semicolon starts a row instead of separating arguments. */
  let brace = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }
    const rest = src.slice(i);
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new FormulaSyntaxError("unterminated string");
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      out.push({ type: "str", v: s, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (ch === "#") {
      const code = ERROR_CODES.find((c) => rest.toUpperCase().startsWith(c));
      if (!code) throw new FormulaSyntaxError(`unknown error value at ${i}`);
      out.push({ type: "err", v: code, start: i, end: i + code.length });
      i += code.length;
      continue;
    }
    // References come before numbers (2:5 is a row range) and identifiers (A1, Sheet1!A1).
    const ref = matchRef(rest, i);
    if (ref) {
      // E1#: the block E1 spills.
      if (ref.shape === "cell" && src[ref.end] === "#") {
        ref.shape = "spill";
        ref.end += 1;
      }
      out.push(ref);
      i = ref.end;
      continue;
    }
    const num = rest.match(RE_NUM);
    if (num) {
      out.push({ type: "num", v: Number(num[0]), start: i, end: i + num[0].length });
      i += num[0].length;
      continue;
    }
    const ident = rest.match(RE_IDENT);
    if (ident) {
      const word = ident[0];
      const end = i + word.length;
      let k = end;
      while (src[k] === " ") k++;
      const upper = word.toUpperCase();
      if (src[k] === "(") out.push({ type: "fn", v: upper, start: i, end });
      else if (upper === "TRUE" || upper === "FALSE") out.push({ type: "bool", v: upper === "TRUE", start: i, end });
      else out.push({ type: "name", v: word, start: i, end });
      i = end;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      out.push({ type: "op", v: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%(),;:{}".includes(ch)) {
      if (ch === "{") brace++;
      if (ch === "}") brace = Math.max(0, brace - 1);
      out.push({ type: "op", v: ch === ";" && !brace ? "," : ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new FormulaSyntaxError(`unexpected "${ch}"`);
  }
  return out;
}

function sheetName(m: RegExpMatchArray): string | undefined {
  if (m[1] !== undefined) return m[1].replace(/''/g, "'");
  return m[2];
}

function matchRef(rest: string, at: number): RefToken | null {
  // "A2:A" (from a cell to the bottom of its columns) before "A2", which would otherwise end the match early.
  let m = rest.match(RE_COLS_FROM);
  if (m) {
    const a: RefPart = { absCol: !!m[3], col: colIdx(m[4]), absRow: !!m[5], row: Number(m[6]) };
    const c1 = colIdx(m[8]);
    if (a.row >= 1 && a.row <= MAX_ROW && a.col <= MAX_COL && c1 <= MAX_COL)
      return { type: "ref", tab: sheetName(m), shape: "colsFrom", a, b: { absCol: !!m[7], col: c1, absRow: true, row: MAX_ROW }, start: at, end: at + m[0].length };
  }
  m = rest.match(RE_CELL_RANGE);
  if (m) {
    const a: RefPart = { absCol: !!m[3], col: colIdx(m[4]), absRow: !!m[5], row: Number(m[6]) };
    if (a.row < 1 || a.row > MAX_ROW || a.col > MAX_COL) return null;
    const tok: RefToken = { type: "ref", tab: sheetName(m), shape: "cell", a, start: at, end: at + m[0].length };
    if (m[8] !== undefined) {
      tok.shape = "range";
      tok.b = { absCol: !!m[7], col: colIdx(m[8]), absRow: !!m[9], row: Number(m[10]) };
      if (tok.b.row < 1 || tok.b.row > MAX_ROW || tok.b.col > MAX_COL) return null;
    }
    return tok;
  }
  m = rest.match(RE_COLS);
  if (m && colIdx(m[4]) <= MAX_COL && colIdx(m[6]) <= MAX_COL) {
    return {
      type: "ref",
      tab: sheetName(m),
      shape: "cols",
      a: { absCol: !!m[3], col: colIdx(m[4]), absRow: false, row: 1 },
      b: { absCol: !!m[5], col: colIdx(m[6]), absRow: false, row: MAX_ROW },
      start: at,
      end: at + m[0].length,
    };
  }
  m = rest.match(RE_ROWS);
  if (m) {
    const r0 = Number(m[4]), r1 = Number(m[6]);
    if (r0 < 1 || r1 < 1 || r0 > MAX_ROW || r1 > MAX_ROW) return null;
    return {
      type: "ref",
      tab: sheetName(m),
      shape: "rows",
      a: { absCol: false, col: 1, absRow: !!m[3], row: r0 },
      b: { absCol: false, col: MAX_COL, absRow: !!m[5], row: r1 },
      start: at,
      end: at + m[0].length,
    };
  }
  return null;
}

// ── AST ─────────────────────────────────────────────────────────────────────

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "err"; v: ErrorCode }
  | { t: "ref"; tab?: string; col: number; row: number }
  | { t: "range"; tab?: string; c0: number; r0: number; c1: number; r1: number }
  | { t: "name"; v: string }
  | { t: "fn"; name: string; args: Node[] }
  | { t: "neg"; a: Node }
  | { t: "pct"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "array"; rows: Array<Array<number | string | boolean>> }
  | { t: "spill"; tab?: string; col: number; row: number }
  | { t: "empty" };

const BINARY: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

/** Parse formula text (without "=") into an AST. Throws FormulaSyntaxError. */
export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => {
    const t = toks[p];
    return !!t && t.type === "op" && t.v === v;
  };

  function expr(minPrec: number): Node {
    let left = unary();
    for (;;) {
      const t = peek();
      if (!t || t.type !== "op") break;
      const prec = BINARY[t.v];
      if (prec === undefined || prec < minPrec) break;
      p++;
      // ^ is left-associative in Excel too.
      const right = expr(prec + 1);
      left = { t: "bin", op: t.v, a: left, b: right };
    }
    return left;
  }

  function unary(): Node {
    if (isOp("-")) {
      p++;
      return { t: "neg", a: unary() };
    }
    if (isOp("+")) {
      p++;
      return unary();
    }
    let node = primary();
    while (isOp("%")) {
      p++;
      node = { t: "pct", a: node };
    }
    return node;
  }

  function primary(): Node {
    const t = toks[p++];
    if (!t) {
      // Say what is missing: "=B2*" needs a value after *, "=SUM(A1," another argument.
      const last = toks[toks.length - 1];
      if (last?.type === "op" && last.v === ",") throw new FormulaSyntaxError("Missing an argument after the last comma");
      if (last?.type === "op" && last.v !== ")") throw new FormulaSyntaxError(`Missing a value after ${last.v}`);
      throw new FormulaSyntaxError("The formula ends too early");
    }
    switch (t.type) {
      case "num":
        return { t: "num", v: t.v };
      case "str":
        return { t: "str", v: t.v };
      case "bool":
        return { t: "bool", v: t.v };
      case "err":
        return { t: "err", v: t.v as ErrorCode };
      case "name":
        return { t: "name", v: t.v };
      case "ref":
        return refNode(t);
      case "fn": {
        if (!isOp("(")) throw new FormulaSyntaxError(`expected ( after ${t.v}`);
        p++;
        const args: Node[] = [];
        if (isOp(")")) {
          p++;
          return { t: "fn", name: t.v, args };
        }
        for (;;) {
          if (isOp(",") || isOp(")")) args.push({ t: "empty" });
          else args.push(expr(1));
          if (isOp(",")) {
            p++;
            if (isOp(")")) {
              args.push({ t: "empty" });
            }
            continue;
          }
          if (isOp(")")) {
            p++;
            break;
          }
          throw new FormulaSyntaxError(`expected , or ) in ${t.v}`);
        }
        return { t: "fn", name: t.v, args };
      }
      case "op":
        if (t.v === "(") {
          const inner = expr(1);
          if (!isOp(")")) throw new FormulaSyntaxError("missing )");
          p++;
          return inner;
        }
        if (t.v === "{") {
          // An array constant: {1,2,3} is a row, {1;2;3} a column, {1,2;3,4} a block.
          const rows: Array<Array<number | string | boolean>> = [[]];
          for (;;) {
            const neg = isOp("-");
            if (neg) p++;
            const v = toks[p++];
            if (!v) throw new FormulaSyntaxError("missing }");
            if (v.type === "num") rows[rows.length - 1].push(neg ? -v.v : v.v);
            else if (!neg && (v.type === "str" || v.type === "bool")) rows[rows.length - 1].push(v.v);
            else throw new FormulaSyntaxError("an array holds only numbers, text and TRUE/FALSE");
            if (isOp(",")) p++;
            else if (isOp(";")) {
              p++;
              rows.push([]);
            } else if (isOp("}")) {
              p++;
              break;
            } else throw new FormulaSyntaxError("expected , ; or } in the array");
          }
          if (rows.some((r) => r.length !== rows[0].length)) throw new FormulaSyntaxError("every row of an array needs the same length");
          return { t: "array", rows };
        }
        throw new FormulaSyntaxError(`unexpected ${t.v}`);
    }
  }

  if (toks.length === 0) throw new FormulaSyntaxError("empty formula");
  const node = expr(1);
  if (p < toks.length) throw new FormulaSyntaxError(`unexpected ${tokText(toks[p], src)}`);
  return node;
}

function tokText(t: Token, src: string): string {
  return src.slice(t.start, t.end);
}

function refNode(t: RefToken): Node {
  if (t.shape === "cell") return { t: "ref", tab: t.tab, col: t.a.col, row: t.a.row };
  if (t.shape === "spill") return { t: "spill", tab: t.tab, col: t.a.col, row: t.a.row };
  const b = t.b!;
  return {
    t: "range",
    tab: t.tab,
    c0: Math.min(t.a.col, b.col),
    r0: Math.min(t.a.row, b.row),
    c1: Math.max(t.a.col, b.col),
    r1: Math.max(t.a.row, b.row),
  };
}

export function isFormula(input: unknown): input is string {
  return typeof input === "string" && input.length > 1 && input[0] === "=";
}
