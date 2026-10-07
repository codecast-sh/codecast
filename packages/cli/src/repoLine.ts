// The repo as the home of a project's line (docs/architecture/line-map.md LX5).
//
// A project's graph and station prompts live beside its profile, in
// `.codecast/line/`: `line.cast` plus one file per station prompt or script,
// referenced the way the shipped template references templates/line/*
// (`prompt="@ground.md"`), so parseWorkflowSource with the directory reads
// them like any workflow file. Nothing is written until a station changes:
// the first station edit writes the shipped line out, then changes it, and a
// reset that leaves every station as shipped removes the copy again, so the
// project follows the shipped line (and its later updates) once more.
//
// Three readers share this module:
//   - the runner (`cast workflow run`, `run-daemon`): a task-bound run of the
//     line in a checkout that has a repo line runs it ahead of the role's line
//     and the shipped one (chooseLineSource, repoLineForRun);
//   - the editor (lineProfileEdit.runLineProfileEdit, the daemon's
//     line_profile_edit): set_station and reset_station plan their writes
//     here, checked by the parser before anything is written (planStationEdits);
//   - the publish (`cast line profile --publish`): the parsed line, its files
//     and its graph_hash ride the profile onto the project row (publishedRepoLine).
import fs from "node:fs";
import path from "node:path";
import lineCast from "./workflow/templates/line.cast" with { type: "text" };
import { LINE_TEMPLATE_FILES, resolveWorkflowSource, type ResolvedWorkflowSource } from "./workflow/templates.js";
import { graphHash, parseWorkflowSource, validateWorkflow } from "./workflow/parser.js";
import { graphToPushPayload } from "./workflow/runner.js";
import { findLineProfile, LineProfileError } from "./lineProfile.js";
import {
  REPO_LINE_FILE_RE,
  REPO_LINE_REL_DIR,
  REPO_LINE_REL_PATH,
  type LineStationEdit,
  type PublishedRepoLine,
} from "@codecast/shared/contracts/lineProfile";
import { DEFAULT_LINE_SLUG, LINE_SLUG_RE } from "@codecast/shared/contracts/orgProposal";

export { REPO_LINE_FILE_RE, REPO_LINE_REL_DIR, REPO_LINE_REL_PATH };

export const repoLineFile = (root: string) => path.join(root, REPO_LINE_REL_PATH);
export const repoLineDir = (root: string) => path.join(root, REPO_LINE_REL_DIR);

const SHIPPED_PREFIX = "line/";

const REPO_LINE_HEADER = [
  "// This project's line (docs/architecture/line-map.md LX5), written out from",
  "// the shipped line by cast the first time a station changed. Each station's",
  "// prompt or script is the file its `@<file>` names, beside this one. A run",
  "// bound to a task in this checkout runs this line ahead of the role's line",
  "// and the shipped one; `cast line profile --publish` shows it in the app.",
  "",
].join("\n");

/** The shipped line as repo files: line.cast with its `@line/<file>` refs made local, and every file they name. */
export function shippedRepoLineFiles(): Record<string, string> {
  const out: Record<string, string> = { "line.cast": REPO_LINE_HEADER + localizeRefs(lineCast) };
  for (const [ref, text] of Object.entries(LINE_TEMPLATE_FILES)) out[ref.slice(SHIPPED_PREFIX.length)] = text;
  return out;
}

const localizeRefs = (source: string) => source.replace(/"@line\//g, '"@');

// ------------------------------------------------------------------ the runner

/** The repo line under the checkout holding `cwd`, as a workflow source, or null when it has none. */
export function repoLineFor(cwd: string): ResolvedWorkflowSource | null {
  const { root } = findLineProfile(cwd);
  if (!root) return null;
  const file = repoLineFile(root);
  return fs.existsSync(file) ? resolveWorkflowSource(file) : null;
}

/**
 * What `cast workflow run` runs (LX5: the repo's line when it exists, else
 * the role's line, else the shipped one). A file named on the command line
 * always wins; the repo's line is taken only for a run bound to a task.
 */
export function chooseLineSource(opts: { file?: string | null; taskBound: boolean; cwd: string; roleSlug?: string | null }):
  { kind: "file"; name: string } | { kind: "repo"; resolved: ResolvedWorkflowSource } | { kind: "role" | "shipped"; name: string } {
  if (opts.file) return { kind: "file", name: opts.file };
  const repo = opts.taskBound ? repoLineFor(opts.cwd) : null;
  if (repo) return { kind: "repo", resolved: repo };
  if (opts.roleSlug) return { kind: "role", name: opts.roleSlug };
  return { kind: "shipped", name: DEFAULT_LINE_SLUG };
}

/**
 * The repo line for a run the daemon executes, or null to run what the run
 * names. Only a task-bound run of a line (its workflow is the shipped line or
 * a role's line slug: `line`, `line-<x>`) is redirected; any other workflow
 * runs as named.
 */
export function repoLineForRun(run: { task_short_id?: string | null; workflow_name?: string | null }, wf: { slug?: string | null } | null | undefined, cwd: string): ResolvedWorkflowSource | null {
  if (!run.task_short_id) return null;
  const name = wf?.slug || run.workflow_name || "";
  if (!isLineSlug(name)) return null;
  return repoLineFor(cwd);
}

const isLineSlug = (s: string) => LINE_SLUG_RE.test(s) && (s === DEFAULT_LINE_SLUG || s.startsWith(`${DEFAULT_LINE_SLUG}-`));

// ------------------------------------------------------------- the DOT text

/** Which characters of `src` are code: false inside strings and comments. */
function codeMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length).fill(1);
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") mask[i++] = 0;
    } else if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      while (i < stop) mask[i++] = 0;
    } else if (src[i] === '"') {
      mask[i++] = 0;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") mask[i++] = 0;
        if (i < src.length) mask[i++] = 0;
      }
      if (i < src.length) mask[i++] = 0;
    } else {
      i++;
    }
  }
  return mask;
}

interface Attr { key: string; entryStart: number; valueStart: number; valueEnd: number; raw: string }
interface NodeStmt { open: number; close: number; attrs: Attr[] }

/** The attribute list of the node statement `<id> [ ... ]`, or null when the source declares no such node. */
export function findNodeStmt(src: string, id: string): NodeStmt | null {
  const mask = codeMask(src);
  const re = new RegExp(String.raw`(^|[\n;{])([ \t]*)(${id.replace(/[^\w]/g, "\\$&")})\s*\[`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const at = m.index + m[1].length + m[2].length;
    if (!mask[at]) continue;
    const open = m.index + m[0].length - 1;
    let close = open + 1;
    while (close < src.length && !(mask[close] && src[close] === "]")) close++;
    if (close >= src.length) return null;
    return { open, close, attrs: lexAttrs(src, mask, open + 1, close) };
  }
  return null;
}

function lexAttrs(src: string, mask: Uint8Array, from: number, to: number): Attr[] {
  const attrs: Attr[] = [];
  let i = from;
  const skip = () => { while (i < to && (/[\s,;]/.test(src[i]) || !mask[i] && src[i] !== '"')) i++; };
  for (;;) {
    skip();
    if (i >= to) break;
    const entryStart = i;
    const key = /^[A-Za-z_][\w]*/.exec(src.slice(i, to))?.[0];
    if (!key) throw new LineProfileError(`cannot read the attributes at ${src.slice(i, i + 20)}`);
    i += key.length;
    while (i < to && /\s/.test(src[i])) i++;
    if (src[i] !== "=") throw new LineProfileError(`attribute ${key} has no value`);
    i++;
    while (i < to && /\s/.test(src[i])) i++;
    const valueStart = i;
    if (src[i] === '"') {
      i++;
      while (i < to && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
    } else {
      while (i < to && !/[\s,;\]]/.test(src[i])) i++;
    }
    attrs.push({ key, entryStart, valueStart, valueEnd: i, raw: src.slice(valueStart, i) });
  }
  return attrs;
}

/** The source with `key` on node `id` set to `raw` (DOT text: a quoted string or a bare value), or removed when raw is null. */
export function setNodeAttr(src: string, id: string, key: string, raw: string | null): string {
  const stmt = findNodeStmt(src, id);
  if (!stmt) throw new LineProfileError(`the line has no station "${id}"`);
  const at = stmt.attrs.findIndex((a) => a.key === key);
  const a = stmt.attrs[at];
  if (raw === null) {
    if (!a) return src;
    // Take the separator before it with it, or the one after it when it leads.
    const prev = stmt.attrs[at - 1];
    const next = stmt.attrs[at + 1];
    if (prev) return src.slice(0, prev.valueEnd) + src.slice(a.valueEnd);
    if (next) return src.slice(0, a.entryStart) + src.slice(next.entryStart);
    return src.slice(0, stmt.open + 1) + src.slice(stmt.close);
  }
  if (a) return src.slice(0, a.valueStart) + raw + src.slice(a.valueEnd);
  const last = stmt.attrs[stmt.attrs.length - 1];
  if (!last) return `${src.slice(0, stmt.open + 1)}${key}=${raw}${src.slice(stmt.close)}`;
  return `${src.slice(0, last.valueEnd)}, ${key}=${raw}${src.slice(last.valueEnd)}`;
}

/** A node attribute's raw DOT text, or null. */
export const nodeAttrRaw = (src: string, id: string, key: string): string | null =>
  findNodeStmt(src, id)?.attrs.find((a) => a.key === key)?.raw ?? null;

/** The file a raw `"@<file>"` value names, or null for an inline value. */
const refOf = (raw: string | null): string | null => {
  const m = raw ? /^"@([^"]+)"$/.exec(raw) : null;
  return m ? m[1] : null;
};

// ------------------------------------------------------------- station edits

export interface StationEditPlan {
  /** Repo-relative paths and their new text, line.cast last. Empty when nothing changed. */
  writes: Array<{ rel: string; content: string }>;
  /** Repo-relative paths to delete, line.cast first: a reset left the line
   *  equal to the shipped one, so the repo's copy goes and the project runs
   *  the shipped line again. Empty otherwise. */
  removes: string[];
  changed: boolean;
  /** True when the repo had no line and this edit writes it out from the shipped one. */
  materialized: boolean;
  /** The stations whose values moved. */
  stations: string[];
  /** The hash a run of the line after these edits records. */
  graph_hash: string;
}

const FIELD_EXT = { prompt: "md", script: "sh" } as const;

/**
 * The writes that apply `edits` to the repo's line under `root`: from the
 * repo's own files, or from the shipped line when it has none. Checked by the
 * parser (every route resolves, every command station keeps a script) before
 * the caller writes anything; throws LineProfileError on a refusal.
 */
export function planStationEdits(root: string, edits: LineStationEdit[]): StationEditPlan {
  const dir = repoLineDir(root);
  const exists = fs.existsSync(repoLineFile(root));
  const shipped = shippedRepoLineFiles();
  const before = new Map<string, string>(exists ? [] : Object.entries(shipped));
  const read = (name: string): string | null => {
    if (before.has(name)) return before.get(name)!;
    const p = path.join(dir, name);
    return exists && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  };
  const files = new Map<string, string>();
  const get = (name: string) => (files.has(name) ? files.get(name)! : read(name));
  let cast = get("line.cast");
  if (cast === null) throw new LineProfileError(`${REPO_LINE_REL_PATH} could not be read`);
  const shippedCast = shipped["line.cast"];
  const touched = new Set<string>();

  const setText = (station: string, field: "prompt" | "script", text: string | null) => {
    const raw = nodeAttrRaw(cast!, station, field);
    if (text === null) { cast = setNodeAttr(cast!, station, field, null); return; }
    const ref = refOf(raw);
    if (ref && REPO_LINE_FILE_RE.test(ref)) { files.set(ref, text); return; }
    // An inline value, or none yet: the station gets its own file.
    let name = `${station}.${FIELD_EXT[field]}`;
    for (let n = 2; get(name) !== null && !refersOnlyFrom(cast!, name, station); n++) name = `${station}-${n}.${FIELD_EXT[field]}`;
    if (!REPO_LINE_FILE_RE.test(name)) throw new LineProfileError(`station "${station}" cannot name a file`);
    files.set(name, text);
    cast = setNodeAttr(cast!, station, field, `"@${name}"`);
  };

  for (const edit of edits) {
    const station = typeof edit?.station === "string" ? edit.station.trim() : "";
    if (!/^[A-Za-z_][\w]*$/.test(station)) throw new LineProfileError(`a station edit needs a station id`);
    if (!findNodeStmt(cast, station)) throw new LineProfileError(`the line has no station "${station}"`);
    touched.add(station);
    if (edit.op === "reset_station") {
      if (!findNodeStmt(shippedCast, station)) throw new LineProfileError(`the shipped line has no station "${station}" to reset to`);
      for (const field of ["prompt", "script"] as const) {
        const raw = nodeAttrRaw(shippedCast, station, field);
        const ref = refOf(raw);
        if (raw === null) setText(station, field, null);
        else if (ref) setText(station, field, shipped[ref]);
        // An inline shipped value goes back inline, exactly as the shipped line writes it.
        else cast = setNodeAttr(cast, station, field, raw);
      }
      cast = setNodeAttr(cast, station, "timeout", nodeAttrRaw(shippedCast, station, "timeout"));
      continue;
    }
    if (edit.op !== "set_station") throw new LineProfileError(`unknown station op "${(edit as any)?.op}"`);
    for (const field of ["prompt", "script"] as const) {
      if (!(field in edit)) continue;
      const v = edit[field];
      if (v !== null && v !== undefined && typeof v !== "string") throw new LineProfileError(`${station} ${field} must be text`);
      setText(station, field, typeof v === "string" && v.trim() ? v : null);
    }
    if ("timeout" in edit) {
      const t = edit.timeout;
      if (t !== null && t !== undefined && (typeof t !== "number" || !Number.isFinite(t))) throw new LineProfileError(`${station} timeout must be a number of seconds`);
      cast = setNodeAttr(cast, station, "timeout", typeof t === "number" && t > 0 ? String(Math.round(t)) : null);
    }
  }

  files.set("line.cast", cast);
  const graph = parseRepoLine(cast, get);
  const graph_hash = graphHash(graph);
  const was = exists ? safeHashes(root) : null;
  const now = new Map(graphToPushPayload(graph).nodes.map((n) => [n.id, stationKey(n)]));
  const moved = () => [...touched].filter((s) => !was || was.get(s) !== now.get(s));

  // A reset that brings the line back to the shipped one removes the repo's
  // copy rather than freezing it, so later shipped updates reach the project.
  if (edits.some((e) => e?.op === "reset_station") && graph_hash === shippedGraphHash(shipped)) {
    if (!exists) return { writes: [], removes: [], changed: false, materialized: false, stations: [], graph_hash };
    const removes = [REPO_LINE_REL_PATH, ...fs.readdirSync(dir).filter((n) => n !== "line.cast" && REPO_LINE_FILE_RE.test(n)).map((n) => path.posix.join(REPO_LINE_REL_DIR, n))];
    return { writes: [], removes, changed: true, materialized: false, stations: moved(), graph_hash };
  }

  // What actually differs from the files as they stand; a materialize writes them all.
  const writes: StationEditPlan["writes"] = [];
  const all = new Map<string, string>(exists ? files : [...before, ...files]);
  for (const [name, content] of all) {
    if (name === "line.cast") continue;
    const p = path.join(dir, name);
    if (exists && fs.existsSync(p) && fs.readFileSync(p, "utf8") === content) continue;
    writes.push({ rel: path.posix.join(REPO_LINE_REL_DIR, name), content });
  }
  const castChanged = !exists || fs.readFileSync(repoLineFile(root), "utf8") !== cast;
  if (castChanged) writes.push({ rel: REPO_LINE_REL_PATH, content: cast });
  const changed = writes.length > 0;
  // Only a station whose parsed values moved counts, so a no-op edit says so.
  return { writes: changed ? writes : [], removes: [], changed, materialized: !exists, stations: changed ? moved() : [], graph_hash };
}

/** The hash a run of the shipped line records, read from the same files a repo copy starts from. */
function shippedGraphHash(shipped: Record<string, string>): string {
  return graphHash(parseRepoLine(shipped["line.cast"], (name) => shipped[name] ?? null));
}

/** Whether `name` is referenced by no station but `station` (so `station` may reuse it). */
function refersOnlyFrom(cast: string, name: string, station: string): boolean {
  for (const n of parseWorkflowSource(cast).nodes.values()) {
    if (n.id !== station && (n.prompt === `@${name}` || n.script === `@${name}`)) return false;
  }
  return true;
}

const stationKey = (n: { prompt?: string; script?: string; timeout?: number }) => JSON.stringify([n.prompt ?? null, n.script ?? null, n.timeout ?? null]);

function safeHashes(root: string): Map<string, string> | null {
  try {
    const r = resolveWorkflowSource(repoLineFile(root));
    if (!r) return null;
    return new Map(graphToPushPayload(parseWorkflowSource(r.source, r.dir)).nodes.map((n) => [n.id, stationKey(n)]));
  } catch {
    return null;
  }
}

/**
 * Parse a repo line with its `@<file>` refs read through `get` (in memory, so
 * a plan is judged before it is written), and refuse what would not run.
 */
function parseRepoLine(cast: string, get: (name: string) => string | null) {
  let graph;
  try {
    graph = parseWorkflowSource(cast);
  } catch (err) {
    throw new LineProfileError(`${REPO_LINE_REL_PATH} does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const node of graph.nodes.values()) {
    for (const field of ["prompt", "script"] as const) {
      const v = node[field];
      if (!v?.startsWith("@")) continue;
      const name = v.slice(1);
      const text = REPO_LINE_FILE_RE.test(name) ? get(name) : null;
      if (text === null) throw new LineProfileError(`station "${node.id}" names ${name}, which is not in ${REPO_LINE_REL_DIR}`);
      node[field] = text;
    }
  }
  const errors = validateWorkflow(graph);
  if (errors.length) throw new LineProfileError(`${REPO_LINE_REL_PATH} would not run: ${errors.join("; ")}`);
  return graph;
}

// ------------------------------------------------------------------ publish

/** The repo's line as the project row carries it (LX5), or null when the repo has none. Throws LineProfileError on a line that would not run. */
export function publishedRepoLine(root: string | null | undefined): PublishedRepoLine | null {
  if (!root) return null;
  const file = repoLineFile(root);
  if (!fs.existsSync(file)) return null;
  const dir = repoLineDir(root);
  const source = fs.readFileSync(file, "utf8");
  const read = (name: string) => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  };
  const graph = parseRepoLine(source, read);
  const { nodes, edges, stack } = graphToPushPayload(graph);
  const files: PublishedRepoLine["files"] = {};
  for (const n of parseWorkflowSource(source).nodes.values()) {
    const prompt = n.prompt?.startsWith("@") ? path.posix.join(REPO_LINE_REL_DIR, n.prompt.slice(1)) : undefined;
    const script = n.script?.startsWith("@") ? path.posix.join(REPO_LINE_REL_DIR, n.script.slice(1)) : undefined;
    if (prompt || script) files[n.id] = { ...(prompt ? { prompt } : {}), ...(script ? { script } : {}) };
  }
  return {
    file: REPO_LINE_REL_PATH,
    graph_hash: graphHash(graph),
    name: graph.name,
    ...(graph.goal ? { goal: graph.goal } : {}),
    ...(stack ? { stack } : {}),
    source,
    nodes,
    edges,
    files,
  };
}
