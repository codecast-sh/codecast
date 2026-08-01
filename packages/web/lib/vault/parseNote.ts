// Single-pass markdown scanner for vault notes.
//
// This is deliberately NOT remark. The index worker reparses thousands of
// notes on boot and on every disk change; an mdast round trip costs ~20x what
// a line scan does and gives us nothing we want (we need line/column anchors
// for links, tags, blocks and tasks, which mdast positions make awkward).
// remark stays the RENDERING parser (lib/remarkEntityIds.ts pattern) — this is
// the INDEXING parser. The shared corpus in __tests__/corpus.ts pins the
// syntax semantics both of them (and, later, the CM6 lezer grammar) must agree
// on.
//
// COORDINATES: `line` is 1-BASED (CodeMirror's `doc.line(n)` takes 1-based
// line numbers, and 1-based reads naturally in UI), `col` is 0-BASED (so
// `rawLine.slice(col)` and `cmLine.from + col` are both correct). Every line
// number in this module obeys that pair; nothing else does anything clever.
//
// CODE HANDLING: fenced code blocks and inline code spans are excluded from
// link/tag/task/block scanning AND from `plainText`. Unlinked mentions are the
// reason — a note title appearing inside a code sample is not a mention, and
// offering to "link" it would rewrite the user's code. The text is not thrown
// away: it lands in `codeText`, so a later full-text pass can index code
// separately (Obsidian's search does match inside code) without polluting the
// mention scan.

/** A heading and the span of lines it owns (up to the next same-or-higher heading). */
export interface NoteHeading {
  text: string;
  level: number;
  /** URL-fragment form used by `[[Note#Heading]]` resolution. */
  slug: string;
  line: number;
  endLine: number;
}

export interface NoteLink {
  /** Vault-relative-ish target as written; "" for same-file links (`[[#Heading]]`). */
  target: string;
  /** Everything after the first `#` (nested heading paths keep their `#`s). */
  subpath?: string;
  subpathType?: "heading" | "block";
  /** Display text after `|`; for image embeds this slot carries the width. */
  alias?: string;
  isEmbed: boolean;
  line: number;
  col: number;
  raw: string;
}

export interface NoteBlock {
  id: string;
  line: number;
  /** The block's own text, stripped of markdown (for backlink context snippets). */
  text: string;
}

export interface NoteTask {
  done: boolean;
  text: string;
  line: number;
}

/** A search-sized slice of a note: one paragraph / list / block, with the
 *  heading trail above it. One minisearch document per chunk. */
export interface NoteChunk {
  text: string;
  line: number;
  endLine: number;
  headingPath: string[];
  blockId?: string;
}

export interface ParsedNote {
  /** Frontmatter `title` > first H1 > null (callers fall back to the basename). */
  title: string | null;
  frontmatter: Record<string, unknown> | null;
  aliases: string[];
  /** Frontmatter tags, normalized without a leading '#'. */
  frontmatterTags: string[];
  /** Inline `#tag` occurrences, normalized without a leading '#'. */
  inlineTags: { tag: string; line: number }[];
  headings: NoteHeading[];
  links: NoteLink[];
  blocks: NoteBlock[];
  tasks: NoteTask[];
  chunks: NoteChunk[];
  /** Markdown stripped to prose: powers search and unlinked mentions. */
  plainText: string;
  /** Fenced-block and inline-code text, kept out of plainText (see header). */
  codeText: string;
  wordCount: number;
}

import { VAULT_ASSET_EXTENSIONS, VAULT_MARKDOWN_EXTENSIONS } from "@codecast/shared/contracts";

const KNOWN_EXTENSIONS: readonly string[] = [
  ...VAULT_MARKDOWN_EXTENSIONS,
  ...VAULT_ASSET_EXTENSIONS,
];

// ---------------------------------------------------------------------------
// Minimal YAML subset
// ---------------------------------------------------------------------------

// Deliberately hand-rolled: `yaml@2` is ~40kB and the index worker needs to
// stay cheap. This covers what frontmatter actually contains — scalars, quoted
// strings, inline arrays, block lists, block scalars, one level of nesting.
// Anything it can't model lands as a plain string rather than throwing, so a
// weird property never costs us the note's links and tags. Property EDITING
// (round-trip preserving writes) is a later task and will want real `yaml`.

function unquote(s: string): string {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c) =>
      c === "n" ? "\n" : c === "t" ? "\t" : c,
    );
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** Split on commas that are not inside quotes. */
function splitTopLevel(inner: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true" || s === "yes") return true;
  if (s === "false" || s === "no") return false;
  if (s.startsWith("[") && s.endsWith("]")) return splitTopLevel(s.slice(1, -1)).map(parseScalar);
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj: Record<string, unknown> = {};
    for (const part of splitTopLevel(s.slice(1, -1))) {
      const at = part.indexOf(":");
      if (at < 0) continue;
      obj[unquote(part.slice(0, at).trim())] = parseScalar(part.slice(at + 1));
    }
    return obj;
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return unquote(s);
}

const indentOf = (line: string): number => line.length - line.replace(/^\s+/, "").length;

function parseYamlSubset(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const m = /^(\s*)([^:#]+?)\s*:\s?(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const [, indent, rawKey, rest] = m;
    const key = unquote(rawKey.trim());
    const base = indent.length;
    const value = rest.trim();

    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const body: string[] = [];
      i++;
      while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > base)) {
        body.push(lines[i].trim());
        i++;
      }
      out[key] = value[0] === "|" ? body.join("\n").trim() : body.join(" ").trim();
      continue;
    }

    if (value !== "") {
      out[key] = parseScalar(value);
      i++;
      continue;
    }

    // Empty value: a block list, a nested map, or genuinely null.
    const items: unknown[] = [];
    const nested: Record<string, unknown> = {};
    let j = i + 1;
    while (j < lines.length) {
      const child = lines[j];
      if (!child.trim()) {
        j++;
        continue;
      }
      if (indentOf(child) <= base) break;
      const listItem = /^\s*-\s*(.*)$/.exec(child);
      if (listItem) items.push(parseScalar(listItem[1]));
      else {
        const kv = /^\s*([^:#]+?)\s*:\s*(.*)$/.exec(child);
        if (kv) nested[unquote(kv[1].trim())] = parseScalar(kv[2]);
      }
      j++;
    }
    // A block list at the SAME indent as its key is legal YAML too.
    if (items.length === 0 && Object.keys(nested).length === 0) {
      let k = i + 1;
      while (k < lines.length) {
        const child = lines[k];
        if (!child.trim()) {
          k++;
          continue;
        }
        const listItem = /^(\s*)-\s*(.*)$/.exec(child);
        if (!listItem || listItem[1].length !== base) break;
        items.push(parseScalar(listItem[2]));
        k++;
      }
      if (items.length) {
        out[key] = items;
        i = k;
        continue;
      }
    }
    out[key] = items.length ? items : Object.keys(nested).length ? nested : null;
    i = j;
  }
  return out;
}

/** Frontmatter list fields accept `a`, `a, b`, `[a, b]`, or a block list. */
function toStringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(toStringList);
  if (typeof value === "string") {
    return value
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  return [];
}

const normalizeTag = (t: string): string => t.replace(/^#+/, "").replace(/\/+$/, "").trim();

// ---------------------------------------------------------------------------
// Inline scanning
// ---------------------------------------------------------------------------

/**
 * Blank out inline code spans, preserving length so every column stays exact.
 * Double-backtick spans (``a `b` c``) close only on a run of the same length,
 * per CommonMark.
 */
function maskCodeSpans(line: string, code: string[]): string {
  if (!line.includes("`")) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i];
      i++;
      continue;
    }
    let run = 0;
    while (line[i + run] === "`") run++;
    // Find a closing run of exactly the same length.
    let j = i + run;
    let close = -1;
    while (j < line.length) {
      if (line[j] === "`") {
        let r = 0;
        while (line[j + r] === "`") r++;
        if (r === run) {
          close = j;
          break;
        }
        j += r;
        continue;
      }
      j++;
    }
    if (close < 0) {
      out += line.slice(i, i + run);
      i += run;
      continue;
    }
    code.push(line.slice(i + run, close));
    out += " ".repeat(close + run - i);
    i = close + run;
  }
  return out;
}

/** True when the character at `idx` is escaped by an odd run of backslashes. */
function isEscaped(line: string, idx: number): boolean {
  let n = 0;
  for (let i = idx - 1; i >= 0 && line[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

const WIKI_LINK_RE = /(!?)\[\[([^[\]\n]+)\]\]/g;
// A tag must start at a line start or after whitespace / an opening bracket —
// `a#b` and `https://x/#frag` are not tags. Charset is unicode letters, digits,
// `_`, `-`, `/` (Obsidian's rule).
const TAG_RE = /(^|[\s([{<"'])#([\p{L}\p{N}_\-/]+)/gu;

export function parseWikiTarget(inner: string): {
  target: string;
  subpath?: string;
  subpathType?: "heading" | "block";
  alias?: string;
} {
  const pipe = inner.indexOf("|");
  const left = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined;
  const hash = left.indexOf("#");
  const target = (hash >= 0 ? left.slice(0, hash) : left).trim();
  if (hash < 0) return alias !== undefined ? { target, alias } : { target };
  const rest = left.slice(hash + 1).trim();
  const isBlock = rest.startsWith("^");
  return {
    target,
    subpath: isBlock ? rest.slice(1) : rest,
    subpathType: isBlock ? "block" : "heading",
    ...(alias !== undefined ? { alias } : {}),
  };
}

/** `Café Réunion — planning` → `café-réunion--planning`. Unicode letters survive. */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

// ---------------------------------------------------------------------------
// Markdown → prose
// ---------------------------------------------------------------------------

const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** Strip markdown syntax from one already-code-masked line. */
function toPlainText(line: string): string {
  // `includes` first: TABLE_DIVIDER_RE has overlapping quantifiers and
  // backtracks quadratically on a long run of dashes that ends up not matching.
  if (line.includes("|") && TABLE_DIVIDER_RE.test(line)) return "";
  if (/^\s*\^[A-Za-z0-9-]+\s*$/.test(line)) return ""; // a bare block id is not prose
  if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) return ""; // thematic break
  let s = line;
  s = s.replace(/^\s{0,3}(?:>\s?)+/, "");
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s*)?/, "");
  s = s.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "");
  s = s.replace(/\s\^[A-Za-z0-9-]+\s*$/, "");
  s = s.replace(/!\[\[[^[\]\n]*\]\]/g, " "); // embeds transclude; not this note's prose
  s = s.replace(/\[\[([^[\]\n]+)\]\]/g, (_m, inner: string) => {
    const { target, subpath, subpathType, alias } = parseWikiTarget(inner);
    if (alias) return alias;
    // Obsidian's display forms: a heading link reads "Note > Heading"; a block
    // id is a machine identifier and is never shown (nor should it be searchable
    // as prose — `^key-claim` would match a search for "key claim").
    if (subpath && subpathType === "heading") return `${target} > ${subpath}`.trim();
    return target;
  });
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, " ");
  s = s.replace(/\|/g, " ");
  // `_` is left alone: snake_case identifiers are far more common in these
  // notes than underscore emphasis, and stripping it corrupts them.
  s = s.replace(/(\*\*|\*|~~|==)/g, "");
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

export function parseNote(content: string): ParsedNote {
  const lines = content.split(/\r\n|\r|\n/);

  let frontmatter: Record<string, unknown> | null = null;
  let start = 0;
  if (lines.length > 1 && /^---\s*$/.test(lines[0])) {
    for (let i = 1; i < lines.length; i++) {
      if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) {
        frontmatter = parseYamlSubset(lines.slice(1, i));
        start = i + 1;
        break;
      }
    }
  }

  const headings: NoteHeading[] = [];
  const links: NoteLink[] = [];
  const blocks: NoteBlock[] = [];
  const tasks: NoteTask[] = [];
  const inlineTags: { tag: string; line: number }[] = [];
  const chunks: NoteChunk[] = [];
  const proseLines: string[] = [];
  const code: string[] = [];

  let fence: RegExp | null = null;
  const headingPath: string[] = [];
  let chunkText: string[] = [];
  let chunkStart = 0;
  let chunkEnd = 0;
  let chunkHeadings: string[] = [];
  let chunkBlockId: string | undefined;
  let lastProse = "";

  const flushChunk = () => {
    const text = chunkText.join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      chunks.push({
        text,
        line: chunkStart,
        endLine: chunkEnd,
        headingPath: chunkHeadings,
        ...(chunkBlockId ? { blockId: chunkBlockId } : {}),
      });
    }
    chunkText = [];
    chunkBlockId = undefined;
  };

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    if (fence) {
      if (fence.test(raw)) fence = null;
      else code.push(raw);
      continue;
    }
    const fenceOpen = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fenceOpen && (fenceOpen[1][0] === "~" || !fenceOpen[2].includes("`"))) {
      // A fence closes on a run of the SAME character at least as long as the
      // opener; the info string ("```ts") belongs to the opener only.
      fence = new RegExp(`^ {0,3}\\${fenceOpen[1][0]}{${fenceOpen[1].length},}\\s*$`);
      flushChunk();
      continue;
    }

    const line = maskCodeSpans(raw, code);

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (heading) {
      flushChunk();
      const level = heading[1].length;
      const text = (heading[2] ?? "").replace(/\s+#+\s*$/, "").trim();
      for (let h = headings.length - 1; h >= 0; h--) {
        if (headings[h].endLine === 0 && headings[h].level >= level) headings[h].endLine = lineNo - 1;
      }
      headings.push({ text, level, slug: slugifyHeading(text), line: lineNo, endLine: 0 });
      headingPath.length = Math.max(0, level - 1);
      headingPath[level - 1] = text;
      chunkHeadings = headingPath.filter(Boolean).slice();
      scanInline(line, lineNo, links, inlineTags);
      const prose = toPlainText(line);
      if (prose) {
        proseLines.push(prose);
        lastProse = prose;
      }
      continue;
    }

    if (!raw.trim()) {
      flushChunk();
      continue;
    }

    scanInline(line, lineNo, links, inlineTags);

    const task = /^(\s*)(?:[-*+])\s+\[(.)\]\s*(.*)$/.exec(line);
    if (task) {
      tasks.push({ done: /[xX]/.test(task[2]), text: toPlainText(task[3]), line: lineNo });
    }

    const block = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line);
    const prose = toPlainText(line);
    if (block) {
      const own = line.slice(0, block.index).trim();
      blocks.push({ id: block[1], line: lineNo, text: own ? prose : lastProse });
      if (own || chunkText.length) {
        chunkBlockId = block[1];
      } else if (chunks.length) {
        // A bare `^id` after a BLANK line still names the paragraph above it,
        // but that chunk was already flushed — reach back and label it, or the
        // id is lost and search results can't offer a block link to it.
        chunks[chunks.length - 1].blockId = block[1];
      }
    }

    if (prose) {
      proseLines.push(prose);
      lastProse = prose;
      if (chunkText.length === 0) chunkStart = lineNo;
      chunkText.push(prose);
      chunkEnd = lineNo;
    }
  }
  flushChunk();
  for (const h of headings) if (h.endLine === 0) h.endLine = lines.length;

  const fmTitle = frontmatter && typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
  const firstH1 = headings.find((h) => h.level === 1);
  const plainText = proseLines.join("\n");

  return {
    title: fmTitle || firstH1?.text || null,
    frontmatter,
    aliases: frontmatter ? toStringList(frontmatter.aliases ?? frontmatter.alias) : [],
    frontmatterTags: frontmatter
      ? toStringList(frontmatter.tags ?? frontmatter.tag)
          .flatMap((t) => t.split(/\s+/))
          .map(normalizeTag)
          .filter(Boolean)
      : [],
    inlineTags,
    headings,
    links,
    blocks,
    tasks,
    chunks,
    plainText,
    codeText: code.join("\n"),
    wordCount: plainText.split(/\s+/).filter(Boolean).length,
  };
}

function scanInline(
  line: string,
  lineNo: number,
  links: NoteLink[],
  inlineTags: { tag: string; line: number }[],
): void {
  if (line.includes("[[")) {
    WIKI_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_LINK_RE.exec(line))) {
      const isEmbed = m[1] === "!";
      // `\[[x]]` escapes the link; `\![[x]]` escapes only the embed marker.
      const bracketAt = m.index + m[1].length;
      if (isEscaped(line, bracketAt)) continue;
      links.push({
        ...parseWikiTarget(m[2]),
        isEmbed: isEmbed && !isEscaped(line, m.index),
        line: lineNo,
        col: m.index,
        raw: m[0],
      });
    }
  }
  if (line.includes("#")) {
    // A markdown link's destination is a URL, so a '#' in it is a fragment,
    // never a tag: `[Intro](#introduction)` must not yield the tag
    // "introduction". Blank the destination (length-preserving, like code
    // spans) for tag scanning only — a `[[wiki link]]` written inside a
    // destination is still a real reference to that note, so link scanning
    // above deliberately sees the unmasked line.
    const forTags = line.includes("](")
      ? line.replace(/\]\([^)\n]*\)/g, (m) => `](${" ".repeat(Math.max(0, m.length - 3))})`)
      : line;
    TAG_RE.lastIndex = 0;
    let t: RegExpExecArray | null;
    while ((t = TAG_RE.exec(forTags))) {
      const tag = normalizeTag(t[2]);
      // Purely numeric tags are not tags (Obsidian's rule): #123 no, #1a yes.
      if (!tag || /^\d+$/.test(tag)) continue;
      inlineTags.push({ tag, line: lineNo });
    }
  }
}

/** `Projects/Meeting Notes.md` → `Projects/Meeting Notes`. ONLY the vault's
 *  known extensions strip: a note legitimately named `Note v1.2` must keep its
 *  `.2`, so guessing at "looks like an extension" is not safe here. */
export function stripKnownExtension(path: string): string {
  const lower = path.toLowerCase();
  for (const ext of KNOWN_EXTENSIONS) {
    if (lower.endsWith(ext) && lower.length > ext.length) return path.slice(0, -ext.length);
  }
  return path;
}

export function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Deduped anchor slugs for a heading list, in document order: the first
 *  occurrence keeps the bare slug (so `[[Note#Details]]` reaches it — the
 *  Obsidian rule), repeats get `-2`, `-3`, …. The reading view's rehype pass
 *  stamps ids with the SAME rule over the same document order, so outline
 *  rows, search-hit jumps, and heading links always agree with the DOM. */
export function headingSlugs(headings: { text: string }[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((h) => {
    const base = slugifyHeading(h.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}
