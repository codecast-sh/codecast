// Replace planning: from a file's text, the query and the replacement, the
// exact edits a replace makes. Pure, so the same plan previews a row, sizes the
// Replace all review, and is what the writer applies.
//
// The text is the file as stored (any line separators, mixed included) or a
// CodeMirror document ("\n" only); offsets index into whichever it was given,
// and every line keeps its own separator, so a CRLF file stays CRLF.
//
// A plan names the matches it was asked for by position (`targets`): the
// matches the person saw in the results. A target the text no longer has there
// is reported missing rather than silently skipped, and the writer refuses the
// whole file then, so nothing is half-applied.

import { matchLine, type LineMatch } from "./query";

export interface MatchTarget {
  /** 1-based. */
  line: number;
  /** UTF-16 column of the match's start in the full line, 0-based. */
  column: number;
}

export interface ReplaceOptions {
  /** `$1`, `$&`, `$<name>`, `\n` and `\t` in the replacement mean what they
   *  mean in a regex replace; otherwise the replacement is literal. */
  regex: boolean;
  /** Match the case of each replaced text: all caps, all lower, Capitalized. */
  preserveCase: boolean;
}

export interface ReplaceEdit {
  from: number;
  to: number;
  insert: string;
  line: number;
  column: number;
}

export interface FileReplacePlan {
  edits: ReplaceEdit[];
  /** Targets the text no longer has a match at. */
  missing: MatchTarget[];
}

/** A line of a text with its offsets, its separator kept apart. */
export interface TextLine {
  number: number;
  from: number;
  text: string;
  sep: string;
}

export function* textLines(text: string): Generator<TextLine> {
  let from = 0;
  let n = 1;
  for (;;) {
    let i = from;
    while (i < text.length && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++;
    const sep = text.startsWith("\r\n", i) ? "\r\n" : i < text.length ? text[i] : "";
    yield { number: n++, from, text: text.slice(from, i), sep };
    if (!sep) return;
    from = i + sep.length;
  }
}

/** The separator most lines of `text` end with ("\n" when there are none). */
export function dominantSeparator(text: string): string {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  return crlf > lf && crlf >= cr ? "\r\n" : cr > lf ? "\r" : "\n";
}

/** The case `sample` is written in, put on `text` (VS Code's preserve case). */
export function withCaseOf(sample: string, text: string): string {
  if (!text || !/\p{L}/u.test(sample)) return text;
  if (sample === sample.toUpperCase()) return text.toUpperCase();
  if (sample === sample.toLowerCase()) return text.toLowerCase();
  const first = sample[0];
  if (first === first.toUpperCase() && first !== first.toLowerCase()) return text[0].toUpperCase() + text.slice(1);
  return text;
}

/** The replacement for one match. `newline` is what `\n` inserts (the line's
 *  own separator, so a CRLF file gains CRLF lines). */
export function expandReplacement(
  match: RegExpExecArray,
  replacement: string,
  opts: ReplaceOptions,
  line: string,
  newline = "\n",
): string {
  if (!opts.regex) return opts.preserveCase ? withCaseOf(match[0], replacement) : replacement;
  let out = "";
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement[i];
    if (c === "\\" && i + 1 < replacement.length) {
      const n = replacement[i + 1];
      if (n === "n" || n === "t" || n === "\\") {
        out += n === "n" ? newline : n === "t" ? "\t" : "\\";
        i++;
        continue;
      }
    }
    if (c !== "$" || i + 1 >= replacement.length) {
      out += c;
      continue;
    }
    const n = replacement[i + 1];
    if (n === "$") {
      out += "$";
      i++;
    } else if (n === "&" || n === "0") {
      out += match[0];
      i++;
    } else if (n === "`") {
      out += line.slice(0, match.index);
      i++;
    } else if (n === "'") {
      out += line.slice(match.index + match[0].length);
      i++;
    } else if (n === "<" && match.groups) {
      const close = replacement.indexOf(">", i + 2);
      if (close < 0) {
        out += c;
        continue;
      }
      out += match.groups[replacement.slice(i + 2, close)] ?? "";
      i = close;
    } else if (n >= "1" && n <= "9") {
      // Two digits when that group exists ($12), else one ($1 then "2").
      const two = replacement[i + 2];
      const twoDigit = two >= "0" && two <= "9" ? Number(n + two) : 0;
      if (twoDigit && twoDigit < match.length) {
        out += match[twoDigit] ?? "";
        i += 2;
      } else if (Number(n) < match.length) {
        out += match[Number(n)] ?? "";
        i++;
      } else out += c;
    } else out += c;
  }
  return opts.preserveCase ? withCaseOf(match[0], out) : out;
}

/** The replaced text of one line's matches, for a preview row. */
export function previewLine(re: RegExp, text: string, replacement: string, opts: ReplaceOptions, only?: number): { matches: LineMatch[]; inserts: string[] } {
  const matches = matchLine(re, text).filter((m) => only === undefined || m.start === only);
  return { matches, inserts: matches.map((m) => expandReplacement(m.m, replacement, opts, text)) };
}

const targetKey = (line: number, column: number) => `${line}:${column}`;

/**
 * The edits replacing `targets` in `text` (every match when `targets` is
 * null). A target at a column where the pattern no longer matches is missing.
 */
export function planReplace(
  text: string,
  re: RegExp,
  replacement: string,
  opts: ReplaceOptions,
  targets: MatchTarget[] | null,
): FileReplacePlan {
  const wanted = targets ? new Set(targets.map((t) => targetKey(t.line, t.column))) : null;
  const lines = targets ? new Set(targets.map((t) => t.line)) : null;
  const found = new Set<string>();
  const edits: ReplaceEdit[] = [];
  const fallbackSep = dominantSeparator(text);
  for (const line of textLines(text)) {
    if (lines && !lines.has(line.number)) continue;
    for (const m of matchLine(re, line.text)) {
      const key = targetKey(line.number, m.start);
      if (wanted && !wanted.has(key)) continue;
      found.add(key);
      edits.push({
        from: line.from + m.start,
        to: line.from + m.end,
        insert: expandReplacement(m.m, replacement, opts, line.text, line.sep || fallbackSep),
        line: line.number,
        column: m.start,
      });
    }
  }
  const missing = targets ? targets.filter((t) => !found.has(targetKey(t.line, t.column))) : [];
  return { edits, missing };
}

/** `text` with `edits` (sorted, non-overlapping) applied. */
export function applyEdits(text: string, edits: ReadonlyArray<{ from: number; to: number; insert: string }>): string {
  let out = "";
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.from) + e.insert;
    at = e.to;
  }
  return out + text.slice(at);
}
