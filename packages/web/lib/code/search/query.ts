// What a project search asks for, and the same question as a JS RegExp.
//
// The daemon runs the search with ripgrep (its Rust regex dialect); the browser
// needs the pattern itself only to replace, to highlight inside the results
// editor, and to check that a match it is about to replace is still there. The
// two dialects agree on everything people type into a search box (classes,
// groups, quantifiers, anchors, \b, \d, \w); where they do not, the browser
// says so on replace rather than replacing something else.
//
// Matching is per line, as ripgrep's is without --multiline: a pattern never
// spans a line break, and ^/$ are the line's ends.

export interface ProjectQuery {
  text: string;
  regex: boolean;
  caseSensitive: boolean;
  word: boolean;
  /** Comma-separated globs, as typed. */
  include: string;
  exclude: string;
  /** Search files the tree hides as ignored too. */
  ignored: boolean;
}

export const EMPTY_PROJECT_QUERY: ProjectQuery = {
  text: "",
  regex: false,
  caseSensitive: false,
  word: false,
  include: "",
  exclude: "",
  ignored: false,
};

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type CompiledQuery = { re: RegExp; error?: undefined } | { re?: undefined; error: string };

/** The query as a global RegExp, or why it is not one. Unicode mode first (so
 *  case folding and word edges follow letters beyond ASCII, as ripgrep's do),
 *  then legacy mode for a pattern only legacy JS accepts (`\-` outside a class). */
export function compileQuery(q: Pick<ProjectQuery, "text" | "regex" | "caseSensitive" | "word">): CompiledQuery {
  if (!q.text) return { error: "empty" };
  const source = q.regex ? q.text : escapeRegExp(q.text);
  const flags = q.caseSensitive ? "g" : "gi";
  try {
    const body = q.word ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source;
    return { re: new RegExp(body, flags + "u") };
  } catch (unicodeError) {
    try {
      return { re: new RegExp(q.word ? `\\b(?:${source})\\b` : source, flags) };
    } catch {
      // "Invalid regular expression: /format(Name/giu: Unterminated group" as its reason.
      return { error: (unicodeError as Error).message.replace(/^Invalid regular expression: /, "").replace(/^\/[\s\S]*\/[a-z]*: /, "") };
    }
  }
}

export interface LineMatch {
  start: number;
  end: number;
  m: RegExpExecArray;
}

/** Every match of `re` in one line, left to right. An empty match advances by
 *  one code point so a pattern like `x*` cannot loop. */
export function matchLine(re: RegExp, text: string): LineMatch[] {
  const out: LineMatch[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length, m });
    if (m[0].length === 0) {
      const c = text.codePointAt(re.lastIndex);
      re.lastIndex += c !== undefined && c > 0xffff ? 2 : 1;
      if (re.lastIndex > text.length) break;
    }
  }
  re.lastIndex = 0;
  return out;
}

/** The include/exclude fields as the daemon's glob lists. */
export function globList(field: string): string[] {
  return field
    .split(/,(?![^{]*\})/)
    .map((g) => g.trim())
    .filter(Boolean);
}

/** A query typed with the notes index's operators (`tag:x`, `path:x`,
 *  `file:x`) is a notes search, whatever the vault. An operator needs a value
 *  attached, so code like `path: string` stays a text search. */
export function usesNoteOperators(text: string): boolean {
  return /(^|\s)-?(tag|path|file):[^\s]/.test(text);
}

/** ripgrep's pattern error, which arrives as its multi-line report flattened
 *  ("regex parse error: (?:foo() ^ error: unclosed group"), as its last clause. */
export function searchErrorText(message: string): string {
  const i = message.lastIndexOf("error:");
  return (i >= 0 ? message.slice(i + 6) : message).replace(/\s+/g, " ").trim();
}
