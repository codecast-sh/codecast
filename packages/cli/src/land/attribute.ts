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
 *   a shell command                       the paths it writes (shellWrites.ts):
 *                                         a redirect's target, sed -i, mv/cp
 *                                         destinations, rm, open(p, "w") in a
 *                                         python heredoc; never one it only
 *                                         reads or runs
 *   a Codex patch                         its *** Update/Add/Delete headers
 *
 * A `cast` command that writes files itself (`cast flow edit`) names none of
 * them in its call, so it records what it wrote in the session write ledger
 * (writeLedger.ts), read here beside the transcripts.
 *
 * A shell command is read for what it says it writes, not what it did; the
 * latest write decides, and a person or formatter's edit leaves no call at
 * all, so such files come back unattributed for the caller to place.
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
import { shellWritePaths } from "./shellWrites.js";
import { readSessionWrites } from "./writeLedger.js";

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
  /** The budget ran out before every transcript was read: owners may name an earlier writer than the last. What was read is kept. */
  partial?: true;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell", "container.exec"]);
const MID_TURN = new Set(["working", "thinking", "compacting", "permission_blocked"]);
/** A mid-turn hook status this old says nothing about now. */
const STATUS_TRUST_MS = 15 * 60_000;
const TAIL_BYTES = 256 * 1024;
/**
 * Bumped whenever what a transcript line is read as changes: the cache keeps each transcript's writes as read and
 * reads only what was appended since, so a fix to the reading reaches lines already read only through a new version.
 * 4: only the paths a command writes, each from the cd in effect (shellWrites.ts).
 */
export const CACHE_VERSION = 4;
/**
 * The hash of the code that decides what a cached line credits (attributeCacheRules.test.ts). A change that moves it
 * bumps CACHE_VERSION, or, when it cannot change a credit, only this pin.
 */
export const CACHE_RULES_HASH = "d82fb90a0f7a95f8";

export function isMidTurn(s: Pick<SessionEdits, "status">): boolean {
  return !!s.status && MID_TURN.has(s.status);
}

function relDirect(root: string, p: string): string | null {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

const realDirs = new Map<string, string>();
/** A path with its directory's symlinks resolved (/tmp/x is /private/tmp/x on macOS), when the directory exists. */
function realOf(p: string): string {
  const dir = path.dirname(p);
  let real = realDirs.get(dir);
  if (real === undefined) {
    try { real = fs.realpathSync(dir); } catch { real = dir; }
    realDirs.set(dir, real);
  }
  return path.join(real, path.basename(p));
}

/** Where other volumes and on-demand mounts live: resolving a path there can wait on a disk or the automounter for minutes. */
const MOUNT_ROOTS = ["/Volumes", "/home", "/net", "/Network", "/mnt", "/media", "/run/media"];
/** macOS's own symlinked roots: /tmp/x is /private/tmp/x. */
const PRIVATE_LINKS: ReadonlyArray<[string, string]> = [["/tmp", "/private/tmp"], ["/var", "/private/var"], ["/etc", "/private/etc"]];

/** The volume a path sits on under a mount root (`/Volumes/Archive`, `/home/ubuntu`), or null for the system's own disk. */
function volumeOf(p: string): string | null {
  for (const m of MOUNT_ROOTS) {
    if (p !== m && !p.startsWith(`${m}/`)) continue;
    const next = p.slice(m.length + 1).split("/")[0];
    return next ? `${m}/${next}` : m;
  }
  return null;
}

const under = (p: string, base: string) => p === base || p.startsWith(`${base}/`);
const rootNames = new Map<string, { real: string; bases: string[]; volumes: Array<string | null> }>();
/** The names a checkout goes by without a symlink anyone made: as given, its real path, and through /tmp and /var's links. */
function namesOf(root: string): { real: string; bases: string[]; volumes: Array<string | null> } {
  let n = rootNames.get(root);
  if (!n) {
    const real = realOf(path.join(root, "x")).slice(0, -2);
    const bases = new Set([root, real]);
    for (const b of [root, real]) for (const [link, target] of PRIVATE_LINKS) {
      if (under(b, target)) bases.add(link + b.slice(target.length));
      if (under(b, link)) bases.add(target + b.slice(link.length));
    }
    n = { real, bases: [...bases], volumes: [...new Set([volumeOf(root), volumeOf(real)])] };
    rootNames.set(root, n);
  }
  return n;
}

const aliases = new Map<string, string | null>();
/**
 * The prefix of `cwd` that is the checkout under a name someone linked (`~/work/app` to `/Volumes/Dev/app`), or
 * null. Only the prefix ending in a segment named like the checkout is ever resolved, and only on the checkout's
 * own volume: a session's cwd elsewhere is never looked at on disk.
 */
function aliasIn(root: string, cwd: string): string | null {
  const n = namesOf(root);
  const name = path.basename(n.real);
  const parts = cwd.split("/");
  const at = parts.lastIndexOf(name);
  if (at <= 0) return null;
  const candidate = parts.slice(0, at + 1).join("/");
  if (n.bases.some((b) => under(candidate, b)) || !n.volumes.includes(volumeOf(candidate))) return null;
  const key = `${root}\0${candidate}`;
  if (!aliases.has(key)) {
    let real: string | null = null;
    try { real = fs.realpathSync(candidate); } catch {}
    aliases.set(key, real === n.real ? candidate : null);
  }
  return aliases.get(key)!;
}

/**
 * Whether `p` can name something inside `root`, from the path's text: under one of the checkout's own names, or
 * under the name the session's cwd reaches it by (aliasIn). Nothing else is touched on disk: commands name paths
 * on other volumes, network mounts, remote hosts and cloud-backed folders (`cd /Volumes/Archive`, `/home/ubuntu`
 * on macOS, which mounts on demand, a Photos library), and resolving one once held attribution for minutes.
 */
function nearRoot(root: string, p: string, cwd?: string): boolean {
  if (namesOf(root).bases.some((b) => under(p, b))) return true;
  const alias = cwd ? aliasIn(root, cwd) : null;
  return !!alias && under(p, alias);
}

/** The repo-relative path of `p`, as written or through the symlinks either side names (git reports a checkout by its real path; a transcript records the path the agent typed). */
function relIn(root: string, p: string, cwd?: string): string | null {
  const direct = relDirect(root, p);
  if (direct !== null || !nearRoot(root, p, cwd)) return direct;
  return relDirect(namesOf(root).real, realOf(p));
}

// ── shell commands ───────────────────────────────────────────────────────────

const checkouts = new Map<string, string | null>();
/** The checkout a directory is in: its nearest ancestor holding a .git (a nested worktree's own, not the one around it). */
function checkoutOf(dir: string): string | null {
  const start = realOf(path.join(dir, "."));
  if (checkouts.has(start)) return checkouts.get(start)!;
  let found: string | null = null;
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) { found = d; break; }
    if (path.dirname(d) === d) break;
  }
  checkouts.set(start, found);
  return found;
}

/** A path's stats, or undefined when nothing is there (missing, or under a file: `package.json/bun.lock`). */
function statOf(p: string): fs.Stats | undefined {
  try { return fs.statSync(p); } catch { return undefined; }
}

/**
 * Repo-relative paths a shell command writes (shellWrites.ts names only writes: a path it reads or runs is never
 * one), each read from the directory the command stood in when it named it, and only when that can be this
 * checkout (nearRoot). A path that does not exist (a file it deleted, or will create) still counts; a directory
 * does not.
 */
export function shellWrites(command: string, cwd: string, root: string): string[] {
  const found = new Set<string>();
  const here = realOf(path.join(root, "."));
  for (const w of shellWritePaths(command, cwd)) {
    let abs = path.isAbsolute(w.path) ? path.normalize(w.path) : path.resolve(w.dir, w.path);
    if (!nearRoot(root, abs, cwd)) continue;
    // A root-relative path written from a directory inside the checkout (the session's cwd is often a package):
    // the checkout's own file when only that one is there.
    if (!path.isAbsolute(w.path) && !statOf(abs) && nearRoot(root, w.dir, cwd) && checkoutOf(w.dir) === here) {
      const fromRoot = path.resolve(root, w.path);
      if (statOf(fromRoot)) abs = fromRoot;
    }
    // A path inside a worktree nested under the checkout (.conductor/<name>) is that worktree's file.
    if (checkoutOf(path.dirname(abs)) !== here) continue;
    const rel = relIn(root, abs, cwd);
    if (!rel || statOf(abs)?.isDirectory() || underAFile(abs)) continue;
    found.add(rel);
  }
  return [...found];
}

/** Whether a path that is not there runs through a file (`README.md/bun.lock`): it names nothing anyone could write. */
function underAFile(p: string): boolean {
  if (statOf(p)) return false;
  for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) {
    const st = statOf(d);
    if (st) return !st.isDirectory();
  }
  return false;
}

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
        if (typeof p === "string") note(relIn(root, path.resolve(cwd, p), cwd), at);
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
        for (const m of patchText.matchAll(PATCH_HEADER)) note(relIn(root, path.resolve(workdir, (m[1] ?? m[2]).trim()), workdir), at);
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

/** The most of a transcript read at once: a long session's transcript runs to hundreds of MB. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Read what `file` appended since the cached offset, a chunk at a time, until it is read or `deadline` passes; a
 * file left part read keeps `size` at what it has read, so the next call goes on from its offset.
 */
function scanIncremental(file: string, size: number, root: string, prior: CacheEntry | undefined, deadline = Infinity, clock: () => number = Date.now): CacheEntry {
  const state: CacheEntry = prior && prior.size <= size && prior.offset <= size
    ? { ...prior, writes: { ...prior.writes } }
    : { offset: 0, size: 0, cwd: null, writes: {} };
  if (state.offset >= size) return { ...state, size };
  const fd = fs.openSync(file, "r");
  try {
    while (state.offset < size) {
      const len = Math.min(size - state.offset, CHUNK_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.offset);
      let lastNewline = buf.lastIndexOf(0x0a);
      let text = buf;
      // A line longer than a chunk: read the rest whole, once.
      if (lastNewline < 0 && state.offset + len < size) {
        text = Buffer.alloc(size - state.offset);
        fs.readSync(fd, text, 0, text.length, state.offset);
        lastNewline = text.lastIndexOf(0x0a);
      }
      if (lastNewline < 0) break;
      scanChunk(text.subarray(0, lastNewline).toString("utf-8"), root, state);
      state.offset += lastNewline + 1;
      if (clock() >= deadline) break;
    }
    // Read to the last whole line: the entry stands for the file at `size`, or, cut short, at the offset reached.
    const done = state.offset >= size || size - state.offset < CHUNK_BYTES && clock() < deadline;
    return { ...state, size: done ? size : state.offset };
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
export function attributeEdits(root: string, paths: Iterable<string>, opts: { since: number; now?: number; ledger?: string; budgetMs?: number; clock?: () => number }): Attribution {
  // The budget's clock (tests drive it, so a budget means the same under any load).
  const clock = opts.clock ?? Date.now;
  const started = clock();
  // A caller on a shared loop (the daemon's checkout report) reads for at most this long, and goes on next call.
  const deadline = opts.budgetMs === undefined ? Infinity : started + opts.budgetMs;
  let partial = false;
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
    const prior = byFile[src.file];
    // Only a file with something left to read spends the budget.
    if (prior?.size !== st.size && clock() >= deadline) { partial = true; continue; }
    const entry = scanIncremental(src.file, st.size, root, prior, deadline, clock);
    if (entry.size < st.size) partial = true;
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
  // What a cast command wrote for a session (writeLedger.ts), credited like a write its transcript shows.
  for (const w of readSessionWrites(root, opts.since, opts.ledger)) {
    if (!wanted.has(w.path)) continue;
    const conversationId = w.conversation ?? conversationBySession[w.session] ?? null;
    const key = conversationId ?? w.session;
    let s = sessions.get(key);
    if (!s) {
      const own = sources.find((src) => src.sessionId === w.session && !src.file.includes(`${path.sep}subagents${path.sep}`));
      let size = 0;
      try { size = own ? fs.statSync(own.file).size : 0; } catch {}
      s = { sessionId: w.session, conversationId, client: own?.client ?? "claude", transcript: own?.file ?? "", edits: new Map(), lastText: own && size ? lastAssistantText(own.file, size) : null, lastActivity: w.at, status: readStatus(w.session, now) };
      sessions.set(key, s);
    }
    if ((s.edits.get(w.path) ?? 0) < w.at) s.edits.set(w.path, w.at);
    if (w.at > s.lastActivity) s.lastActivity = w.at;
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
  return { owners, sessions: [...sessions.values()], scanned, tookMs: clock() - started, ...(partial ? { partial: true as const } : {}) };
}
