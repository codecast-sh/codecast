// Edge conditions (the-line-end-to-end.md LE14): a small expression language
// parsed by hand, never eval()'d.
//
//   expr    := or
//   or      := and (("or" | "||") and)*
//   and     := not (("and" | "&&") not)*
//   not     := ("not" | "!") not | primary
//   primary := "(" expr ")" | operand (cmp operand)?
//   cmp     := = | == | != | > | < | >= | <= | contains
//
// An operand is a quoted string (taken as written) or a bare word. A bare word
// that names a context key reads its value; `context.<key>` reads `<key>`;
// `<node>.json.<path>` reads a field of that node's JSON output. Any other
// bare word is a literal, so `outcome = success` compares the outcome with the
// word success. Ordering operators compare numbers and are false unless both
// sides parse as numbers, so an unset count never routes; `=` and `!=`
// compare numerically when both sides are numbers (`1.0 = 1`), else as text. A lone operand is true when it names a
// context value that is non-empty and not "false" or "0".

type Token =
  | { kind: "op"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "str"; value: string }
  | { kind: "word"; value: string };

type Operand = { quoted: boolean; text: string };

type Node =
  | { kind: "or" | "and"; left: Node; right: Node }
  | { kind: "not"; inner: Node }
  | { kind: "cmp"; op: string; left: Operand; right: Operand }
  | { kind: "truthy"; operand: Operand };

const CMP_OPS = new Set(["=", "==", "!=", ">", "<", ">=", "<=", "contains"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) { value += src[j + 1]; j += 2; continue; }
        value += src[j++];
      }
      if (j >= src.length) throw new Error(`unterminated string at ${i}`);
      tokens.push({ kind: "str", value });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) { tokens.push({ kind: "op", value: two }); i += 2; continue; }
    if ("=<>!".includes(ch)) { tokens.push({ kind: "op", value: ch }); i++; continue; }
    let j = i;
    while (j < src.length && !/[\s()"'=<>!&|]/.test(src[j])) j++;
    if (j === i) throw new Error(`unexpected '${ch}' at ${i}`);
    const word = src.slice(i, j);
    const lower = word.toLowerCase();
    if (lower === "and" || lower === "or" || lower === "not" || lower === "contains") tokens.push({ kind: "op", value: lower });
    else tokens.push({ kind: "word", value: word });
    i = j;
  }
  return tokens;
}

export function parseCondition(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (...values: string[]) => {
    const t = peek();
    return t?.kind === "op" && values.includes(t.value);
  };

  const operand = (): Operand => {
    const t = tokens[pos++];
    if (t?.kind === "str") return { quoted: true, text: t.value };
    if (t?.kind === "word") return { quoted: false, text: t.value };
    throw new Error(t ? `expected a value, got '${"value" in t ? t.value : t.kind}'` : "expected a value at end");
  };

  const primary = (): Node => {
    if (peek()?.kind === "lparen") {
      pos++;
      const inner = or();
      if (tokens[pos++]?.kind !== "rparen") throw new Error("missing ')'");
      return inner;
    }
    const left = operand();
    const t = peek();
    if (t?.kind === "op" && CMP_OPS.has(t.value)) {
      pos++;
      return { kind: "cmp", op: t.value === "==" ? "=" : t.value, left, right: operand() };
    }
    return { kind: "truthy", operand: left };
  };

  const not = (): Node => {
    if (isOp("not", "!")) { pos++; return { kind: "not", inner: not() }; }
    return primary();
  };

  const and = (): Node => {
    let left = not();
    while (isOp("and", "&&")) { pos++; left = { kind: "and", left, right: not() }; }
    return left;
  };

  const or = (): Node => {
    let left = and();
    while (isOp("or", "||")) { pos++; left = { kind: "or", left, right: and() }; }
    return left;
  };

  if (tokens.length === 0) throw new Error("empty condition");
  const tree = or();
  if (pos < tokens.length) throw new Error(`unexpected trailing input in "${src}"`);
  return tree;
}

// The value a dotted path names inside a parsed JSON value, as text.
function walkJson(value: unknown, path: string[]): string | undefined {
  let cur: any = value;
  for (const part of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  if (cur === undefined) return undefined;
  if (cur === null) return "null";
  if (Array.isArray(cur) && path.length > 0) return String(cur.length);
  return typeof cur === "object" ? JSON.stringify(cur) : String(cur);
}

// A context key as a $var or a condition names it. `<node>.json.<path>`
// reads the node's JSON output (stored whole under `<node>.json`); an array
// reads as its length, so `$monitor.json.tasks > 0` counts.
export function lookupContextVar(context: Record<string, string>, key: string): string | undefined {
  if (context[key] !== undefined) return context[key];
  const m = key.match(/^(.+?)\.json\.(.+)$/);
  if (m && context[`${m[1]}.json`] !== undefined) {
    try {
      return walkJson(JSON.parse(context[`${m[1]}.json`]), m[2].split("."));
    } catch {
      return undefined;
    }
  }
  if (key.startsWith("context.")) return lookupContextVar(context, key.slice("context.".length));
  return undefined;
}

function asNumber(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function evalNode(node: Node, context: Record<string, string>): boolean {
  const value = (o: Operand) => (o.quoted ? o.text : lookupContextVar(context, o.text) ?? o.text);
  switch (node.kind) {
    case "or": return evalNode(node.left, context) || evalNode(node.right, context);
    case "and": return evalNode(node.left, context) && evalNode(node.right, context);
    case "not": return !evalNode(node.inner, context);
    case "truthy": {
      const v = node.operand.quoted ? node.operand.text : lookupContextVar(context, node.operand.text);
      return v !== undefined && v !== "" && v !== "false" && v !== "0";
    }
    case "cmp": {
      const a = value(node.left);
      const b = value(node.right);
      if (node.op === "contains") return a.includes(b);
      const na = asNumber(a);
      const nb = asNumber(b);
      const numeric = na !== null && nb !== null;
      switch (node.op) {
        case "=": return numeric ? na === nb : a === b;
        case "!=": return numeric ? na !== nb : a !== b;
        case ">": return numeric && na! > nb!;
        case "<": return numeric && na! < nb!;
        case ">=": return numeric && na! >= nb!;
        case "<=": return numeric && na! <= nb!;
      }
      return false;
    }
  }
}

// A malformed condition never fires (validateWorkflow reports it up front).
export function evalCondition(condition: string, context: Record<string, string>): boolean {
  try {
    return evalNode(parseCondition(condition), context);
  } catch {
    return false;
  }
}

// The syntax error in a condition, or null when it parses.
export function conditionError(condition: string): string | null {
  try {
    parseCondition(condition);
    return null;
  } catch (err: any) {
    return err.message;
  }
}

// A node's output as JSON: the whole text when it parses, else the last
// fenced ```json block in it. Only objects and arrays count.
export function extractJsonOutput(text: string): unknown | undefined {
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s);
      return v !== null && typeof v === "object" ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(text.trim());
  if (whole !== undefined) return whole;
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  return fences.length ? tryParse(fences[fences.length - 1][1].trim()) : undefined;
}
