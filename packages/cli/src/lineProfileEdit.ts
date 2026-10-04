// Key-level edits to `.codecast/line.toml`, applied to the text in place
// (docs/architecture/line-profile.md; plan pl-838). The app edits the profile
// one value at a time, and the file stays the truth a person also edits by
// hand, so an edit must leave every comment, blank line, key order and
// alignment it did not touch exactly as it was. No TOML library in the repo
// round-trips comments (Bun.TOML only parses), so this is a line-level editor:
// it locates tables and key/value spans, rewrites the span it changes, and
// lets the loader judge the result.
//
//   set            a scalar or string array under [line], [line.commands], [line.caps]
//   remove         the same keys, back to their default
//   set_finder     add or update a [[line.finders]] block by id
//   remove_finder  drop a [[line.finders]] block by id
//
// editLineProfile applies edits (or a whole replacement text), validates the
// result with the profile loader, and returns the text with the resolved
// profile; it never touches disk. runLineProfileEdit is the daemon command
// around it: fence, read, edit, atomic write, republish.
import fs from "node:fs";
import path from "node:path";
import {
  CAPS_KEYS,
  COMMAND_KEYS,
  FINDER_KEYS,
  LINE_KEYS,
  LINE_PROFILE_REL_PATH,
  LineProfileError,
  parseLineProfileText,
  resolveLineProfile,
  type ResolvedLineProfile,
} from "./lineProfile.js";
import type { LineFinderInput, LineProfileEdit, LineValue } from "@codecast/shared/contracts/lineProfile";

export type { LineValue, LineFinderInput, LineProfileEdit };

// ---------------------------------------------------------------- the document

interface Entry {
  /** The full dotted path: table name plus the key as written. */
  path: string;
  start: number;
  /** Inclusive: the line the value ends on. */
  end: number;
  /** The key, the `=` and the whitespace after it, as written. */
  prefix: string;
  /** Column on `end` where the value's text stops. */
  valueEnd: number;
}

interface Table {
  name: string;
  array: boolean;
  /** -1 for the root table (before the first header). */
  header: number;
  entries: Entry[];
}

const BARE = String.raw`[A-Za-z0-9_-]+`;
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'`;
const KEY_PART = `(?:${BARE}|${QUOTED})`;
const KEY_RE = new RegExp(String.raw`^(\s*)(${KEY_PART}(?:\s*\.\s*${KEY_PART})*)(\s*=\s*)`);
const HEADER_RE = /^\s*(\[\[|\[)\s*([^[\]]+?)\s*(\]\]|\])\s*(#.*)?$/;

function normalizeDotted(raw: string): string {
  const parts = raw.match(new RegExp(KEY_PART, "g")) ?? [];
  return parts.map((p) => (p.startsWith('"') ? JSON.parse(p) : p.startsWith("'") ? p.slice(1, -1) : p)).join(".");
}

/**
 * Where the value starting at (line, col) ends: its last line and the column
 * after its last character. Follows strings (basic, literal, multi-line),
 * arrays and inline tables across lines, and stops at a comment at depth 0.
 */
function scanValue(lines: string[], line: number, col: number): { end: number; valueEnd: number } {
  let depth = 0;
  let li = line;
  let i = col;
  let end = line;
  let valueEnd = col;
  const mark = (l: number, c: number) => { end = l; valueEnd = c; };
  while (li < lines.length) {
    const s = lines[li];
    if (i >= s.length) {
      if (depth <= 0) break;
      li++;
      i = 0;
      continue;
    }
    const ch = s[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "#") {
      if (depth <= 0) break;
      i = s.length;
      continue;
    }
    const triple = s.startsWith('"""', i) ? '"""' : s.startsWith("'''", i) ? "'''" : null;
    if (triple) {
      const escapes = triple === '"""';
      let l = li;
      let j = i + 3;
      for (;;) {
        const t = lines[l];
        if (t === undefined) return { end: lines.length - 1, valueEnd: lines[lines.length - 1]?.length ?? 0 };
        if (j >= t.length) { l++; j = 0; continue; }
        if (escapes && t[j] === "\\") { j += 2; continue; }
        if (t.startsWith(triple, j)) {
          j += 3;
          // A closing delimiter may carry up to two more quotes of the content.
          for (let extra = 0; extra < 2 && t[j] === triple[0]; extra++) j++;
          break;
        }
        j++;
      }
      li = l;
      i = j;
      mark(li, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) j += ch === '"' && s[j] === "\\" ? 2 : 1;
      i = Math.min(j + 1, s.length);
      mark(li, i);
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    i++;
    mark(li, i);
  }
  return { end, valueEnd };
}

function parseDoc(lines: string[]): Table[] {
  const tables: Table[] = [{ name: "", array: false, header: -1, entries: [] }];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    const header = HEADER_RE.exec(s);
    if (header && header[1].length === header[3].length) {
      tables.push({ name: normalizeDotted(header[2]), array: header[1] === "[[", header: i, entries: [] });
      continue;
    }
    const key = KEY_RE.exec(s);
    if (!key) continue;
    const table = tables[tables.length - 1];
    const { end, valueEnd } = scanValue(lines, i, key[0].length);
    const keyPath = normalizeDotted(key[2]);
    table.entries.push({ path: table.name ? `${table.name}.${keyPath}` : keyPath, start: i, end, prefix: key[0], valueEnd });
    i = end;
  }
  return tables;
}

/** The line after a table's last entry, or after its header when it has none. */
const tableTail = (t: Table) => (t.entries.length ? t.entries[t.entries.length - 1].end + 1 : t.header + 1);

/** The first line of the comment block sitting directly on top of `line` (no blank between). */
function attachedCommentStart(lines: string[], line: number): number {
  let at = line;
  while (at > 0 && /^\s*#/.test(lines[at - 1])) at--;
  return at;
}

/** Insert `block` at `at`, keeping one blank line between it and its neighbours. */
function insertBlock(lines: string[], at: number, block: string[]): void {
  const before = at > 0 && lines[at - 1].trim() !== "" ? [""] : [];
  const after = at < lines.length && lines[at].trim() !== "" ? [""] : [];
  lines.splice(at, 0, ...before, ...block, ...after);
}

// ------------------------------------------------------------------- values

/**
 * A TOML basic string. Tabs go in raw and other control characters are
 * refused: Bun.TOML (the loader) reads `\t` as a form feed and fails on
 * `\u0001`, so only the escapes it decodes faithfully are written.
 */
function tomlString(s: string, where: string): string {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s)) throw new LineProfileError(`${where} must not contain control characters`);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

export function tomlValue(value: LineValue, where: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LineProfileError(`${where} must be a finite number`);
    return String(value);
  }
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) throw new LineProfileError(`${where} must be a list of strings`);
    return `[${value.map((v) => tomlString(v, where)).join(", ")}]`;
  }
  if (typeof value !== "string") throw new LineProfileError(`${where} must be a string, a number or a list of strings`);
  return tomlString(value, where);
}

/** The new text of an entry's line: same key and spacing, new value, the trailing comment kept in its column when it fits. */
function rewriteEntryLine(lines: string[], e: Entry, value: string): string {
  const head = `${e.prefix}${value}`;
  const last = lines[e.end];
  const tail = last.slice(e.valueEnd);
  const comment = /^(\s*)(#.*)$/.exec(tail);
  if (!comment) return head;
  const column = e.start === e.end ? e.valueEnd + comment[1].length : -1;
  const gap = column > head.length ? column - head.length : Math.max(1, comment[1].length);
  return `${head}${" ".repeat(gap)}${comment[2]}`;
}

// -------------------------------------------------------------- primitives

/** Where a profile key lives: its table and the key inside it. Refuses keys the loader does not know. */
export function locateKey(key: string): { table: string; key: string } {
  if (typeof key !== "string") throw new LineProfileError("an edit needs a key");
  const [head, sub, ...rest] = key.split(".");
  const known = [
    ...LINE_KEYS.filter((k) => k !== "commands" && k !== "caps" && k !== "finders"),
    ...COMMAND_KEYS.map((k) => `commands.${k}`),
    ...CAPS_KEYS.map((k) => `caps.${k}`),
  ];
  if (!rest.length && known.includes(key)) {
    if (sub === undefined) return { table: "line", key: head };
    return { table: `line.${head}`, key: sub };
  }
  if (key === "finders") throw new LineProfileError(`edit finders with set_finder and remove_finder`);
  throw new LineProfileError(`unknown key "${key}" (known: ${known.join(", ")})`);
}

/** Set `key` in the table named `tableName`, whose index among same-named tables is `nth` (array tables). */
function setInTable(lines: string[], tableName: string, key: string, value: string, nth = 0): void {
  const tables = parseDoc(lines);
  const full = `${tableName}.${key}`;
  // A live entry anywhere (a dotted key `commands.check` under [line] counts) is rewritten in place.
  const same = tables.filter((t) => t.name === tableName);
  const scope = same.length && same[0].array ? [same[nth]].filter(Boolean) : tables.filter((t) => !t.array);
  for (const t of scope) {
    const e = t.entries.find((x) => x.path === full);
    if (!e) continue;
    lines.splice(e.start, e.end - e.start + 1, rewriteEntryLine(lines, e, value));
    return;
  }
  const table = same[nth];
  if (table) {
    const indent = table.entries[0] ? /^\s*/.exec(table.entries[0].prefix)![0] : "";
    // A commented-out `# key = ...` in this table (a starter file's) becomes the live line, keeping its note.
    const stop = tables[tables.indexOf(table) + 1]?.header ?? lines.length;
    for (let i = table.header + 1; i < stop; i++) {
      const m = /^(\s*)#\s?(.*)$/.exec(lines[i]);
      const live = m ? `${m[1]}${m[2]}` : "";
      const k = m ? KEY_RE.exec(live) : null;
      if (!k || normalizeDotted(k[2]) !== key) continue;
      const scan = scanValue([live], 0, k[0].length);
      lines[i] = rewriteEntryLine([live], { path: full, start: 0, end: 0, prefix: k[0], valueEnd: scan.valueEnd }, value);
      return;
    }
    lines.splice(tableTail(table), 0, `${indent}${key} = ${value}`);
    return;
  }
  // No such table yet: [line] goes on top of the first [line.*] table, a
  // subtable goes on top of the finders, and either goes at the end otherwise.
  const block = [`[${tableName}]`, `${key} = ${value}`];
  const anchor = tableName === "line"
    ? tables.find((t) => t.name.startsWith("line."))
    : tables.find((t) => t.name === "line.finders");
  insertBlock(lines, anchor ? attachedCommentStart(lines, anchor.header) : trimmedEnd(lines), block);
}

function removeFromTable(lines: string[], tableName: string, key: string, nth = 0): void {
  const tables = parseDoc(lines);
  const full = `${tableName}.${key}`;
  const same = tables.filter((t) => t.name === tableName);
  const scope = same.length && same[0].array ? [same[nth]].filter(Boolean) : tables.filter((t) => !t.array);
  for (const t of scope) {
    const e = t.entries.find((x) => x.path === full);
    if (e) { lines.splice(e.start, e.end - e.start + 1); return; }
  }
}

/** The end of the file, before any trailing blank lines. */
function trimmedEnd(lines: string[]): number {
  let at = lines.length;
  while (at > 0 && lines[at - 1].trim() === "") at--;
  return at;
}

/** Index of the [[line.finders]] block with this id, read through the TOML parser so the two always agree. */
function finderIndex(lines: string[], id: string): number {
  let raw: any;
  try {
    raw = Bun.TOML.parse(lines.join("\n"));
  } catch (err) {
    throw new LineProfileError(`invalid TOML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const finders = raw?.line?.finders;
  if (finders === undefined) return -1;
  const blocks = parseDoc(lines).filter((t) => t.array && t.name === "line.finders");
  if (!Array.isArray(finders) || finders.length !== blocks.length) {
    throw new LineProfileError("finders are not written as [[line.finders]] tables; edit the file by hand");
  }
  return finders.findIndex((f: any) => f?.id === id);
}

function setFinder(lines: string[], finder: LineFinderInput): void {
  if (!finder || typeof finder.id !== "string" || !finder.id.trim()) throw new LineProfileError("a finder needs an id");
  const id = finder.id.trim();
  const unknown = Object.keys(finder).filter((k) => !(FINDER_KEYS as readonly string[]).includes(k));
  if (unknown.length) throw new LineProfileError(`finder "${id}" has unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} (known: ${FINDER_KEYS.join(", ")})`);
  const values = Object.fromEntries(
    FINDER_KEYS.map((k) => [k, k === "id" ? id : (finder as any)[k]]).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as Record<string, LineValue>;
  const nth = finderIndex(lines, id);
  if (nth >= 0) {
    for (const k of FINDER_KEYS) {
      if (values[k] === undefined) removeFromTable(lines, "line.finders", k, nth);
      else setInTable(lines, "line.finders", k, tomlValue(values[k], `finder "${id}" ${k}`), nth);
    }
    return;
  }
  const block = ["[[line.finders]]", ...FINDER_KEYS.filter((k) => values[k] !== undefined).map((k) => `${k} = ${tomlValue(values[k], `finder "${id}" ${k}`)}`)];
  const blocks = parseDoc(lines).filter((t) => t.array && t.name === "line.finders");
  insertBlock(lines, blocks.length ? tableTail(blocks[blocks.length - 1]) : trimmedEnd(lines), block);
}

function removeFinder(lines: string[], id: string): void {
  const nth = finderIndex(lines, id);
  if (nth < 0) throw new LineProfileError(`no finder with id "${id}"`);
  const block = parseDoc(lines).filter((t) => t.array && t.name === "line.finders")[nth];
  const from = block.header;
  const to = tableTail(block);
  // A comment sitting on the removed header introduces the finders; it stays and attaches to what follows.
  const attached = from > 0 && /^\s*#/.test(lines[from - 1]);
  lines.splice(from, to - from);
  // Do not leave two blank lines where the block stood, or one at the top.
  while (from < lines.length && lines[from].trim() === "" && (attached || from === 0 || lines[from - 1].trim() === "")) lines.splice(from, 1);
}

// ------------------------------------------------------------------ public

/** Apply edits to profile text in place. Throws LineProfileError on an edit that names an unknown key or finder. */
export function applyLineProfileEdits(text: string, edits: LineProfileEdit[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const edit of edits) {
    switch (edit?.op) {
      case "set": {
        const at = locateKey(edit.key);
        setInTable(lines, at.table, at.key, tomlValue(edit.value, edit.key));
        break;
      }
      case "remove": {
        const at = locateKey(edit.key);
        removeFromTable(lines, at.table, at.key);
        break;
      }
      case "set_finder":
        setFinder(lines, edit.finder);
        break;
      case "remove_finder":
        removeFinder(lines, typeof edit.id === "string" ? edit.id.trim() : "");
        break;
      default:
        throw new LineProfileError(`unknown edit op "${(edit as any)?.op}" (ops: set, remove, set_finder, remove_finder)`);
    }
  }
  return lines.length ? `${lines.join(eol)}${eol}` : "";
}

export interface LineProfileEditResult {
  content: string;
  changed: boolean;
  resolved: ResolvedLineProfile;
}

/**
 * The profile text after `edits` (or the whole replacement `content`),
 * validated by the loader. Throws LineProfileError with the loader's message
 * when the result is not a valid profile; nothing is written either way.
 */
export function editLineProfile(opts: { root: string; current: string; edits?: LineProfileEdit[]; content?: string }): LineProfileEditResult {
  const file = path.join(opts.root, LINE_PROFILE_REL_PATH);
  const content = typeof opts.content === "string" ? opts.content : applyLineProfileEdits(opts.current, opts.edits ?? []);
  const { values, warnings } = parseLineProfileText(content, file);
  return { content, changed: content !== opts.current, resolved: resolveLineProfile(values, { root: opts.root, file, warnings }) };
}

export interface LineProfileEditArgs {
  root: string;
  edits?: LineProfileEdit[];
  content?: string;
  /** The text the caller last read; a whole-text write refuses when the file moved since. */
  base?: string | null;
}

export interface PublishOutcome { ok: boolean; detail?: string }

export interface LineProfileEditReply {
  file: string;
  content: string;
  changed: boolean;
  profile: ResolvedLineProfile["profile"];
  sources: ResolvedLineProfile["sources"];
  notes: string[];
  warnings: string[];
  published: PublishOutcome | null;
}

/**
 * The daemon's `line_profile_edit`: resolve the file under `root`, check the
 * fence, apply and validate, write atomically when it changed, republish.
 * `admit` is the fence (async: the daemon refreshes its tracked roots on a
 * miss); `write` and `publish` are injected so tests run without a daemon.
 */
export async function runLineProfileEdit(
  args: LineProfileEditArgs,
  deps: {
    admit: (file: string) => Promise<string | null>;
    write: (file: string, content: string) => void;
    publish: (root: string) => Promise<PublishOutcome>;
  },
): Promise<LineProfileEditReply> {
  if (!args || typeof args.root !== "string" || !args.root.trim()) throw new LineProfileError("line_profile_edit needs a root");
  if (args.content === undefined && !Array.isArray(args.edits)) throw new LineProfileError("line_profile_edit needs edits or content");
  if (args.content !== undefined && typeof args.content !== "string") throw new LineProfileError("content must be text");
  const root = path.resolve(args.root);
  const file = await deps.admit(path.join(root, LINE_PROFILE_REL_PATH));
  if (!file) throw new LineProfileError(`${path.join(root, LINE_PROFILE_REL_PATH)} is not a line profile in a project this machine tracks`);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (typeof args.content === "string" && typeof args.base === "string" && args.base !== current) {
    throw new LineProfileError("the file changed since it was read; reload it and edit again", file);
  }
  const result = editLineProfile({ root, current, edits: args.edits, content: args.content });
  if (result.changed) deps.write(file, result.content);
  const published = result.changed ? await deps.publish(root) : null;
  const r = result.resolved;
  return { file, content: result.content, changed: result.changed, profile: r.profile, sources: r.sources, notes: r.notes, warnings: r.warnings, published };
}
