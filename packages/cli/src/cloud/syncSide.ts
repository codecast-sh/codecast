/**
 * One side of a sync between a laptop and a cloud host: the same program on
 * both machines, so the two sides always agree on what travels and how a
 * change lands.
 *
 * What travels is the whole working folder: tracked, untracked AND gitignored
 * files (a `.env`, a local config), because both machines are the person's
 * own. Only what is wrong to copy stays behind, each for a reason the person
 * can see in `cast sync status`:
 *
 *   rebuilt   dependency and build folders (node_modules, .venv, target, …),
 *             which the host's own install rebuilds for its own platform
 *   media     an untracked audio or video file (renders, recordings): the
 *             bulk of most working folders and rarely what an agent reads
 *   large     one untracked file over the per-file limit
 *   total     the largest untracked files, while the lot is over the total limit
 *   live      a file a running process owns (a socket, a database journal)
 *   repo      a nested repository (it has its own history to move)
 *   special   a device or fifo
 *   never     a path the person's `never` patterns name
 *
 * A tracked file always travels, whatever its size or folder: leaving one out
 * would read as a deletion on the other side. `always` patterns lift any
 * default rule.
 *
 * The program is a JS string run the same way on both machines (an async
 * function of `require` and the request): in process here, through `bun -e`
 * on the host. A host runs whatever cast version it has, so shipping the
 * program with each request keeps the two sides in step without an update.
 */

import { createRequire } from "node:module";
import { execFile } from "../proc.js";
import { promisify } from "node:util";
import { shq, sshBase, type RemoteHost } from "../remote/session-move.js";
import { describeSyncSkipped, type SyncSkipReason } from "@codecast/shared/contracts";
import { MEDIA_FILE_RE } from "./mirror/discovery.js";

const execFileAsync = promisify(execFile);

/** Folders the host rebuilds itself: never copied unless an `always` pattern names them. */
export const SYNC_REBUILT_DIRS: readonly string[] = [
  "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
  "target", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache",
  ".gradle", "Pods", "DerivedData", ".expo", ".dart_tool", "coverage", ".terraform", ".vercel", ".wrangler",
];

/**
 * Per-machine state inside a repo that never travels and is not worth naming:
 * codecast's workspace profiles, worktrees and setup logs, and the worktrees
 * other agent tools keep there (Claude Code's, Conductor's), each a whole
 * checkout of its own.
 */
export const SYNC_MACHINE_DIRS: readonly string[] = [".codecast/workspaces", ".codecast/worktrees", ".codecast/logs", ".claude/worktrees", ".conductor"];

export const SYNC_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const SYNC_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

export interface SyncScope {
  always?: string[];
  never?: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export type SkipReason = SyncSkipReason;
export interface Skipped { path: string; reason: SkipReason; bytes?: number }

export interface SnapshotResult {
  tree: string;
  /** The snapshot commit (parent HEAD), when asked for one. */
  sha?: string;
  head: string;
  branch: string;
  skipped: Skipped[];
  skippedCount: number;
}

export type SideRequest =
  | { op: "snapshot"; cwd: string; scope?: SyncScope; commit?: boolean; ref?: string }
  | { op: "land"; cwd: string; scope?: SyncScope; sha: string; expectTree: string; moveHead?: string; backupPrefix?: string }
  | { op: "ls"; cwd: string; paths: string[] };

export type LandResult =
  | { landed: true; tree: string; changed: string[]; backupRef?: string }
  | { landed: false; reason: "moved"; tree: string };

export interface LsEntry { path: string; kind: "file" | "dir" | "link" | "missing"; bytes?: number }

/**
 * The program. Plain JS (no types, no template interpolation) because it runs
 * verbatim on the host. Every git call is async: in the daemon this runs on
 * the event loop, and a synchronous walk of a big tree would stall it.
 */
export const SYNC_SIDE_PROGRAM = String.raw`
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const REBUILT = new Set(req.rebuilt);
const MACHINE = req.machine;
const LIVE_RE = /(?:\.sock|\.pid|-journal|\.db-wal|\.db-shm|\.sqlite-wal|\.sqlite-shm)$/;
const MEDIA_RE = new RegExp(req.media, "i");
const cwd = req.cwd;
const scope = req.scope || {};
const maxFile = scope.maxFileBytes || req.defaults.maxFile;
const maxTotal = scope.maxTotalBytes || req.defaults.maxTotal;

function git(args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", ["-C", cwd].concat(args), { env: Object.assign({}, process.env, opts.env || {}), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out = [], err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8"), stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0 && !(opts.ok || []).includes(code)) reject(new Error("git " + args[0] + ": " + (stderr.trim().split("\n").pop() || "exit " + code)));
      else resolve({ stdout, stderr, code });
    });
    child.stdin.end(opts.input || "");
  });
}
const out = async (args, opts) => (await git(args, opts)).stdout.trim();

function globRe(p) {
  let s = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") { if (p[i + 1] === "*") { s += ".*"; i++; if (p[i + 1] === "/") i++; } else s += "[^/]*"; }
    else if (c === "?") s += "[^/]";
    else s += c.replace(/[.+^$(){}|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + s + "(?:/.*)?$");
}
const patterns = (list) => (list || []).map((p) => String(p).replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean).map((p) => p.includes("/") ? { re: globRe(p) } : { re: globRe(p), base: true });
const always = patterns(scope.always), never = patterns(scope.never);
const matches = (list, rel) => list.some((m) => m.re.test(rel) || (m.base && rel.split("/").some((seg) => m.re.test(seg))));
// A dir some always pattern reaches into must be walked, not skipped whole.
const alwaysInside = (rel) => (scope.always || []).some((p) => String(p).replace(/^\.\//, "").startsWith(rel + "/"));

// A file can vanish between the walk and git reading it (a deploy moving
// .env.local aside for a moment): the snapshot is taken again rather than lost.
async function snapshot(commit, ref) {
  for (let attempt = 0; ; attempt++) {
    try { return await snapshotOnce(commit, ref); }
    catch (err) { if (attempt >= 2 || !/unable to stat|No such file|does not exist|did not match/.test(String(err && err.message))) throw err; }
  }
}

async function snapshotOnce(commit, ref) {
  const [real, head, branch] = (await out(["rev-parse", "--path-format=absolute", "--git-path", "index", "HEAD", "--abbrev-ref", "HEAD"])).split("\n");
  const indexed = new Set((await git(["ls-files", "-z"])).stdout.split("\0").filter(Boolean));
  const skipped = [], untracked = [];
  // inRebuilt: walking a rebuilt folder only because an always pattern reaches into it.
  const walk = async (rel, inRebuilt) => {
    let entries;
    try { entries = await fsp.readdir(path.join(cwd, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.name === ".git" || e.name === ".DS_Store") continue;
      if (MACHINE.includes(r)) continue;
      const lifted = matches(always, r);
      if (inRebuilt && !lifted && !alwaysInside(r)) { if (!indexed.has(r)) skipped.push({ path: e.isDirectory() ? r + "/" : r, reason: "rebuilt" }); continue; }
      if (!lifted && matches(never, r)) { if (!indexed.has(r)) skipped.push({ path: e.isDirectory() ? r + "/" : r, reason: "never" }); continue; }
      if (e.isDirectory()) {
        const rebuilt = !lifted && REBUILT.has(e.name);
        if (rebuilt && !alwaysInside(r)) { skipped.push({ path: r + "/", reason: "rebuilt" }); continue; }
        if (fs.existsSync(path.join(cwd, r, ".git")) && !lifted) { skipped.push({ path: r + "/", reason: "repo" }); continue; }
        await walk(r, inRebuilt || rebuilt);
      } else if (e.isSymbolicLink()) {
        if (!indexed.has(r)) untracked.push({ path: r, bytes: 0 });
      } else if (e.isFile()) {
        if (indexed.has(r)) continue;
        if (!lifted && LIVE_RE.test(e.name)) { skipped.push({ path: r, reason: "live" }); continue; }
        if (!lifted && MEDIA_RE.test(e.name)) { let st; try { st = await fsp.lstat(path.join(cwd, r)); } catch { continue; } skipped.push({ path: r, reason: "media", bytes: st.size }); continue; }
        let st; try { st = await fsp.lstat(path.join(cwd, r)); } catch { continue; }
        if (!lifted && st.size > maxFile) { skipped.push({ path: r, reason: "large", bytes: st.size }); continue; }
        untracked.push({ path: r, bytes: st.size, lifted });
      } else if (!indexed.has(r)) skipped.push({ path: r, reason: "special" });
    }
  };
  await walk("", false);
  let total = untracked.reduce((n, f) => n + f.bytes, 0);
  if (total > maxTotal) {
    for (const f of untracked.filter((f) => !f.lifted).sort((a, b) => b.bytes - a.bytes)) {
      if (total <= maxTotal) break;
      total -= f.bytes;
      f.drop = true;
      skipped.push({ path: f.path, reason: "total", bytes: f.bytes });
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-sync-"));
  try {
    const idx = path.join(tmp, "index");
    // The real index carries the stat cache, so unchanged tracked files are not
    // re-read. The copy keeps the original's times: git trusts a cached stat
    // only for files older than the index itself, and a fresh mtime on the
    // copy would hide an edit made in the same second the index was written.
    if (fs.existsSync(real)) { fs.copyFileSync(real, idx); const st = fs.statSync(real); fs.utimesSync(idx, st.atime, st.mtime); }
    const env = { GIT_INDEX_FILE: idx };
    if (!fs.existsSync(idx)) await git(["read-tree", "HEAD"], { env });
    const specs = [".", ...MACHINE.map((d) => ":(exclude,literal)" + d)];
    for (const s of skipped) specs.push(":(exclude,literal)" + s.path.replace(/\/$/, ""));
    for (const f of untracked) if (f.drop) specs.push(":(exclude,literal)" + f.path);
    const list = path.join(tmp, "specs");
    fs.writeFileSync(list, specs.join("\0"));
    // -f: gitignored files travel too; the excludes above are what stays behind.
    await git(["add", "-A", "-f", "--pathspec-from-file=" + list, "--pathspec-file-nul"], { env });
    // A tracked file inside a skipped folder still travels as it is now.
    const tracked = [...indexed];
    const inside = skipped.filter((s) => s.path.endsWith("/")).map((s) => s.path.slice(0, -1)).filter((d) => tracked.some((f) => f.startsWith(d + "/")));
    if (inside.length) {
      fs.writeFileSync(list, inside.join("\0"));
      await git(["add", "-u", "--pathspec-from-file=" + list, "--pathspec-file-nul"], { env });
    }
    const tree = await out(["write-tree"], { env });
    const res = { tree, head, branch, skipped: skipped.slice(0, 200), skippedCount: skipped.length };
    if (commit) {
      const date = (await out(["log", "-1", "--format=%cI", head])) || "1970-01-01T00:00:00Z";
      const id = { GIT_AUTHOR_NAME: "codecast", GIT_AUTHOR_EMAIL: "codecast@localhost", GIT_COMMITTER_NAME: "codecast", GIT_COMMITTER_EMAIL: "codecast@localhost", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
      res.sha = await out(["commit-tree", tree, "-p", head, "-m", "codecast wip snapshot", "-m", "codecast-branch: " + branch], { env: id });
      if (ref) await git(["update-ref", ref, res.sha]);
    }
    return res;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Write only what differs between the tree as it is and the tree to land:
// untouched files keep their bytes and times, so an editor or a dev server
// here sees exactly the files that changed.
async function applyDiff(from, to) {
  const raw = (await git(["diff-tree", "-r", "-z", "--no-renames", from, to])).stdout.split("\0");
  const edits = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const meta = raw[i].replace(/^:/, "").split(" ");
    if (meta.length < 5) continue;
    edits.push({ mode: meta[1], sha: meta[3], status: meta[4], path: raw[i + 1] });
  }
  const blobs = edits.filter((e) => e.status !== "D" && e.mode !== "160000").map((e) => e.sha);
  const bodies = new Map();
  if (blobs.length) {
    const out = await new Promise((resolve, reject) => {
      const child = cp.spawn("git", ["-C", cwd, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const chunks = [];
      child.stdout.on("data", (d) => chunks.push(d));
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("git cat-file: exit " + code)));
      child.stdin.end([...new Set(blobs)].join("\n") + "\n");
    });
    let at = 0;
    while (at < out.length) {
      const nl = out.indexOf(10, at);
      const [sha, , size] = out.subarray(at, nl).toString().split(" ");
      const n = Number(size);
      bodies.set(sha, out.subarray(nl + 1, nl + 1 + n));
      at = nl + 1 + n + 1;
    }
  }
  const touched = [];
  for (const e of edits.filter((x) => x.status === "D")) {
    const abs = path.join(cwd, e.path);
    try { fs.unlinkSync(abs); } catch (err) { if (err.code !== "ENOENT") throw err; }
    touched.push(e.path);
    for (let d = path.dirname(abs); d.length > cwd.length; d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
  }
  for (const e of edits.filter((x) => x.status !== "D")) {
    const abs = path.join(cwd, e.path);
    touched.push(e.path);
    if (e.mode === "160000") { fs.mkdirSync(abs, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // A folder where a file now goes (or the other way) gives way first.
    try { const st = fs.lstatSync(abs); if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true }); } catch {}
    const tmp = path.join(path.dirname(abs), ".codecast-sync-" + process.pid + "-" + path.basename(abs));
    if (e.mode === "120000") { try { fs.unlinkSync(tmp); } catch {} fs.symlinkSync(bodies.get(e.sha).toString(), tmp); }
    else fs.writeFileSync(tmp, bodies.get(e.sha), { mode: e.mode === "100755" ? 0o755 : 0o644 });
    if (e.mode !== "120000") fs.chmodSync(tmp, e.mode === "100755" ? 0o755 : 0o644);
    fs.renameSync(tmp, abs);
  }
  return touched;
}

async function land() {
  const now = await snapshot(false);
  if (now.tree !== req.expectTree) return { landed: false, reason: "moved", tree: now.tree };
  const tree = await out(["rev-parse", req.sha + "^{tree}"]);
  const changed = await applyDiff(req.expectTree, tree);
  let backupRef;
  if (req.moveHead) {
    const head = await out(["rev-parse", "HEAD"]);
    if (head !== req.moveHead) {
      const kept = (await git(["merge-base", "--is-ancestor", head, req.moveHead], { ok: [1] })).code === 1;
      if (kept && req.backupPrefix) { backupRef = req.backupPrefix + "/" + Date.now(); await git(["update-ref", backupRef, head]); }
      await git(["update-ref", "--no-deref", "HEAD", req.moveHead]);
      await git(["reset", "-q", "--mixed", req.moveHead]);
    }
  }
  return { landed: true, tree, changed: changed.slice(0, 500), backupRef };
}

async function ls() {
  const res = [];
  for (const p of req.paths) {
    const abs = p.startsWith("/") ? p : path.join(cwd, p);
    let st; try { st = await fsp.lstat(abs); } catch { res.push({ path: p, kind: "missing" }); continue; }
    if (st.isSymbolicLink()) res.push({ path: p, kind: "link" });
    else if (st.isDirectory()) {
      let bytes = 0;
      const du = async (d) => { for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) { const f = path.join(d, e.name); if (e.isDirectory()) await du(f); else if (e.isFile()) bytes += (await fsp.lstat(f)).size; } };
      await du(abs);
      res.push({ path: p, kind: "dir", bytes });
    } else res.push({ path: p, kind: "file", bytes: st.size });
  }
  return res;
}

if (req.op === "snapshot") return await snapshot(req.commit, req.ref);
if (req.op === "land") return await land();
if (req.op === "ls") return await ls();
throw new Error("unknown op " + req.op);
`;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
const localRequire = createRequire(import.meta.url);

function withConstants(req: SideRequest): object {
  return { ...req, rebuilt: SYNC_REBUILT_DIRS, machine: SYNC_MACHINE_DIRS, media: MEDIA_FILE_RE.source, defaults: { maxFile: SYNC_MAX_FILE_BYTES, maxTotal: SYNC_MAX_TOTAL_BYTES } };
}

let compiled: ((...a: unknown[]) => Promise<unknown>) | null = null;

/** Run one side's operation on this machine. */
export async function runSide<T = unknown>(req: SideRequest): Promise<T> {
  compiled ??= new AsyncFunction("require", "req", SYNC_SIDE_PROGRAM);
  return (await compiled(localRequire, withConstants(req))) as T;
}

/** The shell command that runs the same operation on a host (bun ships with every host). */
export function remoteSideCommand(req: SideRequest): string {
  const boot = `const F=Object.getPrototypeOf(async()=>{}).constructor;new F("require","req",${JSON.stringify(SYNC_SIDE_PROGRAM)})(require,JSON.parse(process.argv[1])).then((r)=>process.stdout.write(JSON.stringify(r)),(e)=>{process.stderr.write(String(e&&e.message||e));process.exit(1)})`;
  return `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; bun -e ${shq(boot)} -- ${shq(JSON.stringify(withConstants(req)))}`;
}

/** Run one side's operation on a host over its ssh connection. */
export async function runRemoteSide<T = unknown>(host: RemoteHost, req: SideRequest, timeoutMs = 120_000): Promise<T> {
  try {
    const { stdout } = await execFileAsync("ssh", [...sshBase(host), `${host.user}@${host.address}`, remoteSideCommand(req)], { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split("\n").pop() || "null") as T;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr?.trim().split("\n").filter(Boolean).pop() || err.message || String(e)).slice(0, 300);
    throw new Error(`on the host: ${detail}`);
  }
}

/** One line per skipped path, the way status and the chip name it. */
export const describeSkipped = describeSyncSkipped;
