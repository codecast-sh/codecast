/**
 * Which session wrote each uncommitted file in a shared checkout.
 *
 * Every agent transcript the daemon syncs is in the sync ledger
 * (syncLedger.ts: transcript path -> conversation), and a workflow's or
 * subagent's transcript sits under its parent's directory
 * (`<project>/<parent session>/subagents/...`), so it counts as the parent's.
 * A file belongs to the session whose write of it came last. Writes are read
 * from three kinds of tool call:
 *
 *   Edit, Write, MultiEdit, NotebookEdit  the path the call names
 *   a shell command that writes           every path it names that resolves
 *                                         inside the checkout (sed -i, a
 *                                         python heredoc, a redirect, mv, ...)
 *   a Codex patch                         its *** Update/Add/Delete headers
 *
 * A shell command is matched by what it says, not what it did, so a command
 * that both reads one file and writes another credits both; the latest write
 * still decides, and a person or formatter's edit leaves no call at all, so
 * such files come back unattributed for the caller to place.
 *
 * Transcripts only grow, so each one is read once: the scan keeps the offset
 * and the writes found so far (cache/land-attribution.json) and reads only
 * what was appended since.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfigDir } from "../config/configDir.js";
import { claudeProjectDirName } from "../projectPathResolver.js";
import { getAllSyncRecords } from "../syncLedger.js";
import { readLocalConversationMap } from "../localConversationMap.js";

export interface SessionEdits {
  sessionId: string;
  conversationId: string | null;
  client: string;
  transcript: string;
  /** Repo-relative path -> time of this session's last write of it. */
  edits: Map<string, number>;
  /** The session's last words, when its transcript ends with assistant text. */
  lastText: string | null;
  /** The newest mtime among its transcripts. */
  lastActivity: number;
  /** The hook status on disk (working, idle, ...); "stale" when a mid-turn status went quiet. */
  status: string | null;
}

export interface Attribution {
  /** Repo-relative path -> the session that wrote it last. */
  owners: Map<string, SessionEdits>;
  sessions: SessionEdits[];
  scanned: number;
  tookMs: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell", "container.exec"]);
const MID_TURN = new Set(["working", "thinking", "compacting", "permission_blocked"]);
/** A mid-turn hook status this old says nothing about now. */
const STATUS_TRUST_MS = 15 * 60_000;
const TAIL_BYTES = 256 * 1024;
const CACHE_VERSION = 2;

export function isMidTurn(s: Pick<SessionEdits, "status">): boolean {
  return !!s.status && MID_TURN.has(s.status);
}

function relIn(root: string, p: string): string | null {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

// ── shell commands ───────────────────────────────────────────────────────────

/** Redirections that write nothing worth crediting. */
const NULL_REDIRECTS = /\d?>&\d|&>\s*\/dev\/null|\d?>>?\s*\/dev\/null/g;
const WRITES = /\bsed\s+(?:-[a-zA-Z]*\s+)*-i|\bperl\s+-[a-z]*i|open\([^)]*['"](?:w|a|wb|w\+)['"]|write_text|write_bytes|writeFileSync|\.write\(|>>?\s*['"]?[\w./~$-]|\btee\b|\bmv\s|\bcp\s|\brm\s|\bgit\s+(?:apply|checkout|restore|mv|rm)\b|\bpatch\s|\bunlink\b|\btouch\s|\bln\s/;
/** Tokens that look like a path: a slash or a file extension. */
const PATH_TOKEN = /[\w@~.+-]*(?:\/[\w@.+-]+)+\/?|[\w@+-][\w@.+-]*\.[A-Za-z][\w]{0,9}/g;

/** Directories a command `cd`s into, in order, resolved from `cwd`. */
function cdTargets(command: string, cwd: string): string[] {
  const dirs: string[] = [];
  let at = cwd;
  for (const m of command.matchAll(/(?:^|[;&|(\n]\s*)cd\s+(['"]?)([^'";&|\n)]+)\1/g)) {
    const dir = m[2].trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
    at = path.resolve(at, dir);
    dirs.push(at);
  }
  return dirs;
}

/** Repo-relative paths a writing shell command names. */
export function shellWrites(command: string, cwd: string, root: string): string[] {
  if (!WRITES.test(command.replace(NULL_REDIRECTS, " "))) return [];
  const bases = [...new Set([cwd, ...cdTargets(command, cwd), root])];
  const found = new Set<string>();
  for (const m of command.matchAll(PATH_TOKEN)) {
    const token = m[0].replace(/^\.\//, "");
    if (token.length < 3 || token.includes("://")) continue;
    for (const base of token.startsWith("/") ? [""] : bases) {
      const abs = base ? path.resolve(base, token) : token;
      const rel = relIn(root, abs);
      if (rel && fs.existsSync(abs)) { found.add(rel); break; }
      if (rel && !base) found.add(rel);
    }
  }
  return [...found];
}

// ── transcripts ──────────────────────────────────────────────────────────────

const PATCH_HEADER = /\*\*\* (?:Update|Add|Delete) File: ([^\n\\]+)|\*\*\* Move to: ([^\n\\]+)/g;

interface ScanState {
  offset: number;
  cwd: string | null;
  /** Repo-relative path -> last write time, for every path inside the root. */
  writes: Record<string, number>;
}

/** Parse the complete lines in `chunk`, updating `state`. */
export function scanChunk(chunk: string, root: string, state: ScanState): void {
  const note = (rel: string | null, at: number) => {
    if (rel && (state.writes[rel] ?? 0) <= at) state.writes[rel] = at;
  };
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    // Cheap gates before JSON.parse: most lines are messages, reads and results.
    const hasCall = line.includes("\"tool_use\"") || line.includes("function_call") || line.includes("custom_tool_call");
    const hasPatch = line.includes("*** ");
    if (!state.cwd && line.includes("\"cwd\"")) {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) state.cwd = JSON.parse(`"${m[1]}"`);
    }
    if (!hasCall && !hasPatch) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const at = Date.parse(obj?.timestamp) || 0;
    const cwd = (typeof obj?.cwd === "string" && obj.cwd) || state.cwd || root;

    // Claude: tool_use blocks in an assistant message.
    for (const block of Array.isArray(obj?.message?.content) ? obj.message.content : []) {
      if (block?.type !== "tool_use") continue;
      const input = block.input ?? {};
      if (EDIT_TOOLS.has(block.name)) {
        const p = input.file_path ?? input.notebook_path;
        if (typeof p === "string") note(relIn(root, path.resolve(cwd, p)), at);
      } else if (SHELL_TOOLS.has(block.name) && typeof input.command === "string") {
        for (const rel of shellWrites(input.command, cwd, root)) note(rel, at);
      }
    }

    // Codex: function calls carrying a shell command or a patch.
    const payload = obj?.payload;
    if (payload && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
      let args: any = payload.arguments ?? payload.input;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch {} }
      const command = Array.isArray(args?.command) ? args.command.join(" ") : typeof args?.command === "string" ? args.command : typeof args?.cmd === "string" ? args.cmd : null;
      const workdir = typeof args?.workdir === "string" ? path.resolve(cwd, args.workdir) : cwd;
      if (command) for (const rel of shellWrites(command, workdir, root)) note(rel, at);
      const patchText = typeof args === "string" ? args : command ?? (typeof args?.input === "string" ? args.input : null);
      if (patchText?.includes("*** ")) {
        for (const m of patchText.matchAll(PATCH_HEADER)) note(relIn(root, path.resolve(workdir, (m[1] ?? m[2]).trim())), at);
      }
    }
  }
}

interface CacheEntry extends ScanState { size: number }
type Cache = { version: number; roots: Record<string, Record<string, CacheEntry>> };

function cacheFile(): string {
  return path.join(defaultConfigDir(), "cache", "land-attribution.json");
}

function loadCache(): Cache {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(), "utf-8"));
    if (data?.version === CACHE_VERSION && data.roots) return data;
  } catch {}
  return { version: CACHE_VERSION, roots: {} };
}

function saveCache(cache: Cache): void {
  const file = cacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

/** Read what `file` appended since the cached offset. */
function scanIncremental(file: string, size: number, root: string, prior: CacheEntry | undefined): CacheEntry {
  const state: CacheEntry = prior && prior.size <= size && prior.offset <= size
    ? { ...prior, writes: { ...prior.writes } }
    : { offset: 0, size: 0, cwd: null, writes: {} };
  if (state.offset >= size) return { ...state, size };
  const fd = fs.openSync(file, "r");
  try {
    const len = size - state.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.offset);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) return { ...state, size };
    scanChunk(buf.subarray(0, lastNewline).toString("utf-8"), root, state);
    return { ...state, offset: state.offset + lastNewline + 1, size };
  } finally {
    fs.closeSync(fd);
  }
}

function readStatus(sessionId: string, now: number): string | null {
  try {
    const file = path.join(defaultConfigDir(), "agent-status", `${sessionId}.json`);
    const st = fs.statSync(file);
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const ts = typeof data.ts === "number" ? (data.ts < 1e12 ? data.ts * 1000 : data.ts) : st.mtimeMs;
    if (MID_TURN.has(data.status) && now - Math.max(ts, st.mtimeMs) > STATUS_TRUST_MS) return "stale";
    return typeof data.status === "string" ? data.status : null;
  } catch {
    return null;
  }
}

/** The last assistant text in a Claude or Codex transcript's tail. */
function lastAssistantText(file: string, size: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    for (const line of buf.toString("utf-8").split("\n").reverse()) {
      if (!line.includes("assistant") && !line.includes("agent_message")) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      const blocks = obj?.message?.role === "assistant" ? obj.message.content : null;
      if (Array.isArray(blocks)) {
        const text = blocks.filter((b: any) => b?.type === "text" && b.text?.trim()).map((b: any) => b.text).join("\n").trim();
        if (text) return text;
      }
      const codex = obj?.payload?.type === "agent_message" ? obj.payload.message : null;
      if (typeof codex === "string" && codex.trim()) return codex.trim();
    }
  } catch {} finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

/** Subagent and workflow transcripts under this repo's Claude project dirs, keyed to their parent session. */
function subagentTranscripts(root: string, since: number): Array<{ file: string; parent: string }> {
  const projects = path.join(process.env.HOME ?? "", ".claude", "projects");
  const prefix = claudeProjectDirName(root);
  const out: Array<{ file: string; parent: string }> = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projects).filter((d) => d === prefix || d.startsWith(`${prefix}-`)); } catch { return out; }
  for (const d of dirs) {
    let parents: fs.Dirent[] = [];
    try { parents = fs.readdirSync(path.join(projects, d), { withFileTypes: true }); } catch { continue; }
    for (const p of parents) {
      if (!p.isDirectory()) continue;
      const sub = path.join(projects, d, p.name, "subagents");
      let st: fs.Stats;
      try { st = fs.statSync(sub); } catch { continue; }
      if (st.mtimeMs < since - 86_400_000) continue;
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const f = path.join(dir, e.name);
          if (e.isDirectory()) walk(f);
          else if (e.name.endsWith(".jsonl")) out.push({ file: f, parent: p.name });
        }
      };
      try { walk(sub); } catch {}
    }
  }
  return out;
}

/**
 * Attribute `paths` (repo-relative) to the sessions that wrote them. Only
 * transcripts written since `since` are read: a write older than the oldest
 * dirty file cannot be the one that left it dirty.
 */
export function attributeEdits(root: string, paths: Iterable<string>, opts: { since: number; now?: number }): Attribution {
  const started = Date.now();
  const now = opts.now ?? started;
  const wanted = new Set(paths);
  const cache = loadCache();
  const byFile = (cache.roots[root] ??= {});
  const conversationBySession = readLocalConversationMap();

  const sources: Array<{ file: string; sessionId: string; conversationId: string | null; client: string }> = [];
  for (const [file, record] of Object.entries(getAllSyncRecords())) {
    const sessionId = record.sourceGeneration?.sessionId ?? path.basename(file).replace(/\.jsonl$/, "");
    const client = record.sourceGeneration?.client ?? (file.includes("/.codex/") ? "codex" : "claude");
    sources.push({ file, sessionId, conversationId: record.conversationId ?? null, client });
  }
  for (const { file, parent } of subagentTranscripts(root, opts.since)) {
    sources.push({ file, sessionId: parent, conversationId: conversationBySession[parent] ?? null, client: "claude" });
  }

  const sessions = new Map<string, SessionEdits>();
  const seenFiles = new Set<string>();
  let scanned = 0;
  for (const src of sources) {
    let st: fs.Stats;
    try { st = fs.statSync(src.file); } catch { continue; }
    seenFiles.add(src.file);
    if (st.mtimeMs < opts.since) continue;
    const entry = scanIncremental(src.file, st.size, root, byFile[src.file]);
    if (entry.offset !== byFile[src.file]?.offset) scanned++;
    byFile[src.file] = entry;
    const hits = Object.entries(entry.writes).filter(([p]) => wanted.has(p));
    if (!hits.length) continue;
    const key = src.conversationId ?? src.sessionId;
    let s = sessions.get(key);
    if (!s) {
      s = { sessionId: src.sessionId, conversationId: src.conversationId, client: src.client, transcript: src.file, edits: new Map(), lastText: null, lastActivity: 0, status: readStatus(src.sessionId, now) };
      sessions.set(key, s);
    }
    for (const [p, at] of hits) if ((s.edits.get(p) ?? 0) < at) s.edits.set(p, at);
    // The parent's own transcript speaks for the session, not a worker's.
    if (st.mtimeMs > s.lastActivity) s.lastActivity = st.mtimeMs;
    if (!src.file.includes(`${path.sep}subagents${path.sep}`)) {
      s.transcript = src.file;
      s.lastText = lastAssistantText(src.file, st.size);
    }
  }
  for (const f of Object.keys(byFile)) if (!seenFiles.has(f)) delete byFile[f];
  try { saveCache(cache); } catch {}

  const owners = new Map<string, SessionEdits>();
  for (const s of sessions.values()) {
    for (const [p, at] of s.edits) {
      const cur = owners.get(p);
      if (!cur || (cur.edits.get(p) ?? 0) < at) owners.set(p, s);
    }
  }
  return { owners, sessions: [...sessions.values()], scanned, tookMs: Date.now() - started };
}
