// Claude Code memory folders (~/.claude/projects/<project>/memory): the rules
// for reading one. Shared because three readers must agree: the daemon's
// /memory routes, the web Memory page, and the cloud mirror that merges a
// host's MEMORY.md back into the laptop's (cloud/mirror/memoryBack.ts).
//
// A memory is a markdown file with `name`/`description`/`metadata.type`
// frontmatter. MEMORY.md is the index Claude Code loads at session start; it
// links memories with `[text](file.md)`, and memories link each other with
// `[[name]]`. Parsing goes through the vault's parseNote, so code spans and
// fences never produce links here either.
//
// PURE isomorphic data — no Node or DOM APIs.
import { parseNote } from "../vault/parseNote";
import { splitFrontmatter as splitVaultFrontmatter } from "../vault/frontmatter";

export const MEMORY_INDEX_FILE = "MEMORY.md";
/** Claude Code loads MEMORY.md whole lines at a time until the running total
 *  passes either cap. Measured against its own truncation warning. */
export const MEMORY_INDEX_MAX_BYTES = 25_000;
export const MEMORY_INDEX_MAX_LINES = 200;
/** Past this an index line is spending budget that belongs to later lines. */
export const MEMORY_INDEX_LINE_SOFT_MAX = 200;
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export const MEMORY_FILE_RE = /^[\w.\- ]+\.md$/;

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/** A link names a memory by its `name:` slug or its file stem, in any case and
 *  with hyphens or underscores; this key makes all of those meet. */
export function memoryLinkKey(s: string): string {
  return s.trim().toLowerCase().replace(/\.md$/, "").replace(/[-\s]+/g, "_");
}

/** Every memory a piece of markdown points at, as written, code excluded. */
export function memoryLinkTargets(markdown: string): string[] {
  const parsed = parseNote(markdown);
  const out = new Set<string>();
  for (const l of parsed.links) if (l.target) out.add(l.target);
  for (const l of parsed.markdownLinks) if (/\.md$/i.test(l.target)) out.add(l.target.split("/").pop()!);
  return [...out];
}

/** The memory files one MEMORY.md line links to. */
export function indexLineFiles(line: string): string[] {
  return parseNote(line).markdownLinks.map((l) => l.target).filter((t) => /\.md$/i.test(t));
}

export function indexLines(raw: string): string[] {
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export interface MemoryIndexBudget {
  bytes: number;
  lines: number;
  /** 1-based first line Claude Code does not load; null when it all loads. */
  cutAt: number | null;
  maxBytes: number;
  maxLines: number;
}

export function memoryIndexBudget(raw: string): MemoryIndexBudget {
  const lines = indexLines(raw);
  let bytes = 0;
  let cutAt: number | null = null;
  lines.forEach((line, i) => {
    bytes += byteLength(line) + 1;
    if (cutAt === null && (bytes > MEMORY_INDEX_MAX_BYTES || i + 1 > MEMORY_INDEX_MAX_LINES)) cutAt = i + 1;
  });
  return { bytes: byteLength(raw), lines: lines.length, cutAt, maxBytes: MEMORY_INDEX_MAX_BYTES, maxLines: MEMORY_INDEX_MAX_LINES };
}

export const lineBytes = (line: string) => byteLength(line) + 1;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** The frontmatter block and the body after it, by the vault's fence rules.
 *  The body starts at its first non-blank line. */
export function splitFrontmatter(raw: string): { fm: string; body: string } {
  const [fm, body] = splitVaultFrontmatter(raw);
  return fm === null ? { fm: "", body: raw } : { fm, body: body.replace(/^(?:\r?\n)+/, "") };
}

export function joinFrontmatter(fm: string, body: string): string {
  return fm ? `---\n${fm}\n---\n\n${body.replace(/^\n+/, "")}` : body;
}

export interface MemoryFields {
  name: string;
  description: string;
  type: string;
}

export function readMemoryFields(raw: string): MemoryFields & { hasFrontmatter: boolean } {
  const fm = parseNote(raw).frontmatter ?? {};
  const meta = (fm.metadata && typeof fm.metadata === "object" ? fm.metadata : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  return {
    name: str(fm.name),
    description: str(fm.description),
    type: str(meta.type ?? fm.type),
    hasFrontmatter: splitFrontmatter(raw).fm !== "",
  };
}

const yamlScalar = (v: string) => (/^[\w./-]+$/.test(v) ? v : JSON.stringify(v));

/** Set one of the fields the editor owns. Every other line of the frontmatter
 *  (originSessionId, modified, node_type, …) is left byte for byte. */
export function writeMemoryField(raw: string, key: keyof MemoryFields, value: string): string {
  const { fm, body } = splitFrontmatter(raw);
  const line = `${key}: ${yamlScalar(value)}`;
  let next: string;
  if (key === "type") {
    const block = fm.match(/^metadata:[ \t]*\n((?:[ \t]+.*(?:\n|$))*)/m);
    if (block && /^[ \t]+type:/m.test(block[1])) {
      next = fm.replace(block[1], block[1].replace(/^([ \t]+)type:.*$/m, `$1type: ${yamlScalar(value)}`));
    } else if (/^type:/m.test(fm)) {
      next = fm.replace(/^type:.*$/m, line);
    } else if (block) {
      next = fm.replace(/^metadata:[ \t]*\n/m, `metadata:\n  type: ${yamlScalar(value)}\n`);
    } else {
      next = `${fm ? `${fm.replace(/\n*$/, "")}\n` : ""}metadata:\n  type: ${yamlScalar(value)}`;
    }
  } else if (new RegExp(`^${key}:`, "m").test(fm)) {
    next = fm.replace(new RegExp(`^${key}:.*$`, "m"), line);
  } else if (key === "description" && /^name:/m.test(fm)) {
    next = fm.replace(/^(name:.*)$/m, `$1\n${line}`);
  } else {
    next = fm ? `${line}\n${fm}` : line;
  }
  return joinFrontmatter(next, body);
}

export function newMemoryRaw(fields: MemoryFields, body = ""): string {
  let raw = joinFrontmatter("name: x", body);
  raw = writeMemoryField(raw, "name", fields.name);
  raw = writeMemoryField(raw, "description", fields.description);
  return writeMemoryField(raw, "type", fields.type);
}

/** The file a new memory named `name` gets. */
export function memoryFileFor(name: string): string {
  return `${memoryLinkKey(name).replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "memory"}.md`;
}

/** The MEMORY.md line that points at a memory. */
export function memoryIndexLine(file: string, fields: Pick<MemoryFields, "name" | "description">): string {
  return `- [${(fields.description || fields.name).replace(/[[\]]/g, "")}](${file})`;
}

export function appendIndexLine(indexRaw: string, line: string): string {
  return `${indexRaw ? indexRaw.replace(/\n*$/, "\n") : ""}${line}\n`;
}

/** Drop the index lines that point at `file` and nothing else. A line that also
 *  points elsewhere stays, and the atlas reports its dangling link. */
export function removeIndexLinesFor(indexRaw: string, file: string): { raw: string; removed: number } {
  const key = memoryLinkKey(file);
  let removed = 0;
  const kept = indexRaw.split("\n").filter((line) => {
    const files = indexLineFiles(line);
    const drop = files.length === 1 && memoryLinkKey(files[0]) === key;
    if (drop) removed++;
    return !drop;
  });
  return { raw: kept.join("\n"), removed };
}

// ---------------------------------------------------------------------------
// The atlas: every memory, its links, and whether Claude ever reaches it
// ---------------------------------------------------------------------------

export interface MemoryFile {
  file: string;
  raw: string;
  mtime: number;
  bytes: number;
}

// ---------------------------------------------------------------------------
// What the daemon's /memory routes answer (cli/src/memory/memoryServer.ts)
// ---------------------------------------------------------------------------

export interface MemoryProjectSummary {
  id: string;
  /** The working directory the project's sessions ran in, when a transcript says so. */
  path: string;
  count: number;
  index: MemoryIndexBudget;
  updated: number;
}

export interface MemoryProject {
  id: string;
  path: string;
  dir: string;
  files: MemoryFile[];
  index: { raw: string; mtime: number | null };
}

/** How a memory reaches Claude at session start, best first. */
export type MemoryReach = "loaded" | "reachable" | "cut" | "orphan";
export const MEMORY_REACH: readonly MemoryReach[] = ["loaded", "reachable", "cut", "orphan"];

export interface MemoryNote extends MemoryFields {
  file: string;
  raw: string;
  body: string;
  hasFrontmatter: boolean;
  bytes: number;
  mtime: number;
  links: { raw: string; file: string | null }[];
  /** First MEMORY.md line pointing here, 1-based. */
  indexLine: number | null;
  reach: MemoryReach;
  inbound: string[];
}

export interface MemoryAtlas {
  notes: MemoryNote[];
  byFile: Map<string, MemoryNote>;
  edges: { source: string; target: string }[];
  index: { raw: string; lines: string[]; refs: { raw: string; file: string | null }[][]; budget: MemoryIndexBudget };
  resolve: (target: string) => string | null;
}

export function buildMemoryAtlas(files: readonly MemoryFile[], indexRaw: string): MemoryAtlas {
  const memories = files.filter((f) => f.file !== MEMORY_INDEX_FILE);
  const byKey = new Map<string, string>();
  const parsed = memories.map((f) => {
    const fields = readMemoryFields(f.raw);
    byKey.set(memoryLinkKey(f.file), f.file);
    if (fields.name) byKey.set(memoryLinkKey(fields.name), f.file);
    return { f, fields };
  });
  const resolve = (target: string) => byKey.get(memoryLinkKey(target.split("/").pop() ?? target)) ?? null;

  const lines = indexLines(indexRaw);
  const refs = lines.map((line) => indexLineFiles(line).map((raw) => ({ raw, file: resolve(raw) })));
  const indexLineOf = new Map<string, number>();
  refs.forEach((rs, i) => rs.forEach((r) => r.file && !indexLineOf.has(r.file) && indexLineOf.set(r.file, i + 1)));
  const budget = memoryIndexBudget(indexRaw);

  const notes: MemoryNote[] = parsed.map(({ f, fields }) => ({
    ...fields,
    name: fields.name || f.file.replace(/\.md$/, ""),
    type: fields.type || "untyped",
    file: f.file,
    raw: f.raw,
    body: splitFrontmatter(f.raw).body,
    bytes: f.bytes,
    mtime: f.mtime,
    links: memoryLinkTargets(splitFrontmatter(f.raw).body).map((raw) => ({ raw, file: resolve(raw) })),
    indexLine: indexLineOf.get(f.file) ?? null,
    reach: "orphan",
    inbound: [],
  }));
  const byFile = new Map(notes.map((n) => [n.file, n]));

  const edges: MemoryAtlas["edges"] = [];
  for (const n of notes) {
    for (const target of new Set(n.links.map((l) => l.file).filter((f): f is string => !!f && f !== n.file))) {
      edges.push({ source: n.file, target });
      byFile.get(target)!.inbound.push(n.file);
    }
  }

  // Loaded = indexed above the cut; reachable = a link chain from a loaded one.
  const loads = (line: number | null) => line !== null && (budget.cutAt === null || line < budget.cutAt);
  const queue = notes.filter((n) => loads(n.indexLine));
  const seen = new Set(queue.map((n) => n.file));
  for (const n of queue) n.reach = "loaded";
  while (queue.length) {
    for (const l of queue.shift()!.links) {
      if (!l.file || seen.has(l.file)) continue;
      seen.add(l.file);
      const target = byFile.get(l.file)!;
      target.reach = "reachable";
      queue.push(target);
    }
  }
  for (const n of notes) if (!seen.has(n.file)) n.reach = n.indexLine !== null ? "cut" : "orphan";

  return { notes, byFile, edges, index: { raw: indexRaw, lines, refs, budget }, resolve };
}
