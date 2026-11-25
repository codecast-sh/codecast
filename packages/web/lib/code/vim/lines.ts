// Reading a vimrc into commands: line continuations, `|` separators and
// trailing comments, each by the rules of the command it belongs to.

export interface LogicalLine {
  /** 1-based line of the first physical line. */
  line: number;
  text: string;
}

/** Join `\` continuation lines onto the line before; drop `"\ ` comment
 *  lines inside a continuation. */
export function logicalLines(content: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  const phys = content.split(/\r\n|\n|\r/);
  for (let i = 0; i < phys.length; i++) {
    const raw = phys[i];
    if (out.length && /^\s*"\\ /.test(raw)) continue;
    if (out.length && /^\s*\\/.test(raw)) {
      out[out.length - 1].text += raw.replace(/^\s*\\/, "");
      continue;
    }
    out.push({ line: i + 1, text: raw });
  }
  return out;
}

/** How a command reads `|` and `"`. */
type Grammar =
  | "whole" // the rest of the line is the command's (autocmd, command, normal, :g)
  | "map" // `|` ends it unless escaped; no comments
  | "expr" // an expression: strings, `||`, comments where an operator could go
  | "plain"; // `\|` escapes, `"` after whitespace starts a comment

const WHOLE = /^(au(t(o(c(m(d)?)?)?)?)?|com(m(a(n(d)?)?)?)?!?|norm(a(l)?)?|g(l(o(b(a(l)?)?)?)?)?|v(g(l(o(b(a(l)?)?)?)?)?)?|windo|bufdo|tabdo|argdo|cdo|ldo|folddoopen|folddoc(losed)?|lua|py(thon)?3?|pyx?|perl|rub(y)?|Plug|exe(c(u(t(e)?)?)?)?)$/;
const EXPR = /^(let|if|elsei(f)?|wh(i(l(e)?)?)?|for|cal(l)?|ec(h(o)?)?|echom(sg)?|echoe(rr)?|retu(r(n)?)?|unl(e(t)?)?)$/;
const MAP = /^([nvxsoilct]?(m(a(p)?)?|no(r(e(m(a(p)?)?)?)?)?|(un|u)(m(a(p)?)?)?)|[nvxsoilct](nor(e(m(a(p)?)?)?)?|u(n(m(a(p)?)?)?)?)|nn(o(r(e(m(a(p)?)?)?)?)?)?|vn(o(r(e(m(a(p)?)?)?)?)?)?|xn(o(r(e(m(a(p)?)?)?)?)?)?|ino(r(e(m(a(p)?)?)?)?)?|ono(r(e(m(a(p)?)?)?)?)?|cno(r(e(m(a(p)?)?)?)?)?|snor(e(m(a(p)?)?)?)?|tno(r(e(m(a(p)?)?)?)?)?|ln(o(r(e(m(a(p)?)?)?)?)?)?|tma(p)?|ab(b(r(e(v(i(a(t(e)?)?)?)?)?)?)?)?|[ic]a(b(b(r(e(v)?)?)?)?)?|[ic]?norea(b(b(r(e(v)?)?)?)?)?)!?$/;

const AUTOCMD_CLEAR = /^au(?:t(?:o(?:c(?:m(?:d)?)?)?)?)?!(?:\s+[^\s|]+){0,2}\s*(?=\|)/;

function grammarOf(word: string): Grammar {
  if (WHOLE.test(word)) return "whole";
  if (MAP.test(word)) return "map";
  if (EXPR.test(word)) return "expr";
  return "plain";
}

/** Where a command ends: at a `|` separator, at a comment, or at the end. */
function boundary(s: string, grammar: Grammar, start: number): { at: number; comment: boolean } | null {
  if (grammar === "whole") return null;
  let operand = true;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (grammar === "map") {
      if ((c === "\\" || c === "\x16") && s[i + 1] === "|") i++;
      else if (c === "|") return { at: i, comment: false };
      continue;
    }
    if (grammar === "plain") {
      if (c === "\\") i++;
      else if (c === "|") return { at: i, comment: false };
      else if (c === '"' && (i === 0 || /\s/.test(s[i - 1]))) return { at: i, comment: true };
      continue;
    }
    // expr
    if (c === "'") {
      for (i++; i < s.length; i++) {
        if (s[i] === "'" && s[i + 1] === "'") i++;
        else if (s[i] === "'") break;
      }
      operand = false;
    } else if (c === '"') {
      if (!operand) return { at: i, comment: true };
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
      operand = false;
    } else if (c === "|") {
      if (s[i + 1] === "|") {
        i++;
        operand = true;
      } else return { at: i, comment: false };
    } else if (c === "&" && s[i + 1] === "&") {
      i++;
      operand = true;
    } else if (/[\w:#$&]/.test(c)) {
      operand = false;
    } else if (c === ")" || c === "]" || c === "}") {
      operand = false;
    } else if (!/\s/.test(c)) {
      operand = true;
    }
  }
  return null;
}

/** The commands of one line, each cut at its own `|` or comment. */
export function splitCommands(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.trim()) {
    // `silent!` changes nothing a vimrc reader cares about.
    const s = rest.replace(/^[\s:]+/, "").replace(/^sil(e(n(t)?)?)?!?\s+/, "");
    const word = /^([A-Za-z]+!?)/.exec(s)?.[1] ?? "";
    // `autocmd!` that only clears (no command) ends at `|`, as in
    // `augroup vimrc | autocmd! | augroup END`.
    const clear = AUTOCMD_CLEAR.exec(s);
    const b = clear ? { at: clear[0].length, comment: false } : boundary(s, grammarOf(word.replace(/!$/, "")), word.length);
    if (!b) {
      out.push(s.trimEnd());
      break;
    }
    const cmd = s.slice(0, b.at).trimEnd();
    if (cmd) out.push(cmd);
    if (b.comment) break;
    rest = s.slice(b.at + 1);
  }
  return out;
}

/** A map's arguments end at a `"` comment only where nothing else could be
 *  meant: whitespace, a quote, then whitespace (no register is named " "). */
export function stripMapComment(args: string): string {
  const m = /\s+"\s.*$/.exec(args);
  if (!m) return args;
  const kept = args.slice(0, m.index);
  // Keep it when cutting would leave the map with no right-hand side.
  return /\S\s+\S/.test(kept.trim().replace(/^(<\w+>\s*)+/, "")) ? kept : args;
}
