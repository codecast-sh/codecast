import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawnSync } from "../../proc.js";
import { promisify } from "node:util";
import { FORCE_PERSISTENCE_VAR, ensureClaudeSettingsPersistence } from "../../agentEnv.js";
import { isCodecastHookCommand, isCodecastOwnedHomePath } from "../../codecastOwned.js";
import { installAllStableHooks } from "../../stableContext.js";
import { maskPins, readHostMcpOverrides, writeHostMcpOverrides, type HostMcpOverrides, type McpSourceServer } from "../hostMcpOverrides.js";
import { assertMirrorFileContent, assertSafePath, sha256, type ParsedBundle, type ParsedFile } from "./bundle.js";
import {
  dropCodecastHooks, findAllOwnedSections, joinTomlTables, splitTomlTables, stripOwnedSections, tableFirstSegment,
  type MirrorKind, type TomlTable,
} from "./transform.js";

// ---------------------------------------------------------------------------
// Stamp + result shapes
// ---------------------------------------------------------------------------

export interface StampFile {
  /** sha256 of the bytes the laptop sent. */
  sha: string;
  /** sha256 of mirrored bytes, or owned MCP fields when mcp_fields is present. */
  written: string;
  mode: "0600" | "0700";
  /** Absent in stamps older than the kind-aware prune: treated as verbatim. */
  kind?: MirrorKind;
  /** Unresolved host edits keep the stamp incomplete. */
  host_edited?: true;
  source?: string;
  removed?: true;
  alias?: string;
  satisfied_alias?: { project: string; target: string };
  mcp_disabled?: string[];
  mcp_fields?: string[][];
}

export interface MirrorStamp {
  version: 1;
  hash: string;
  source_device_id: string;
  source_user_id: string;
  applied_at: string;
  files: Record<string, StampFile>;
  managed_roots: string[];
  complete?: boolean;
  desired_hash?: string;
  mcp_overrides_hash?: string;
}

export type RefusedReason = "other_user" | "unprovisioned" | "other_device" | "other_home";

export interface ApplyResult {
  hash: string;
  applied: string[];
  unchanged: number;
  host_edited: string[];
  pruned: string[];
  errors: Array<{ path: string; error: string }>;
  refused?: RefusedReason;
  retired_projects?: string[];
}

export const MIRROR_STAMP_REL = ".codecast/mirror.json";
export const MIRROR_LOCK_REL = ".codecast/mirror.lock";
export const MIRRORED_ENV_MANIFEST_REL = ".codecast/mirrored-claude-env.json";
export const GITCONFIG_BLOCK_START = "# >>> codecast mirror";
export const GITCONFIG_BLOCK_END = "# <<< codecast mirror";

/** Kinds written as the laptop sent them; host edits to these are detected and kept. */
const VERBATIM_KINDS: readonly MirrorKind[] = ["verbatim", "json-remap", "toml-remap", "gemini-settings", "opencode-json", "gitignore"];

const execFileAsync = promisify(execFile);

export async function cleanTrackedFiles(root: string): Promise<Map<string, { hash: string; mode: string }>> {
  try {
    const options = { encoding: "utf8" as const, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 };
    const [head, index] = await Promise.all([
      execFileAsync("git", ["-C", root, "ls-tree", "-r", "-z", "HEAD"], options),
      execFileAsync("git", ["-C", root, "ls-files", "--stage", "-z"], options),
    ]);
    const staged = new Set(index.stdout.split("\0"));
    const out = new Map<string, { hash: string; mode: string }>();
    for (const row of head.stdout.split("\0")) {
      const match = /^(100(?:644|755)) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
      if (match && staged.has(`${match[1]} ${match[2]} 0\t${match[3]}`)) out.set(match[3]!, { hash: match[2]!, mode: match[1]! });
    }
    return out;
  } catch {
    return new Map();
  }
}

export function matchesGitBlob(bytes: Buffer, mode: number, tracked: { hash: string; mode: string } | undefined): boolean {
  if (!tracked || !!(mode & 0o111) !== (tracked.mode === "100755")) return false;
  return createHash(tracked.hash.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === tracked.hash;
}

export function readStamp(home: string): MirrorStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, MIRROR_STAMP_REL), "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.version === 1 && typeof parsed.hash === "string") {
      parsed.files = parsed.files && typeof parsed.files === "object" ? parsed.files : {};
      parsed.managed_roots = Array.isArray(parsed.managed_roots) ? parsed.managed_roots : [];
      return parsed as MirrorStamp;
    }
  } catch { /* absent or unreadable: no stamp */ }
  return null;
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 250;
const LOCK_UNREADABLE_STALE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Exclusive ~/.codecast/mirror.lock: an O_EXCL pid+token file. A holder whose
 * pid is dead is broken immediately; an unreadable file older than 5s too;
 * otherwise wait up to 60s in 250ms polls, then give up with the holder's pid.
 */
export async function withMirrorLock<T>(home: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const file = path.join(home, MIRROR_LOCK_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let holderPid: number | null = null;
    let stale = false;
    let seen: string | null = null;
    try {
      seen = fs.readFileSync(file, "utf-8");
      const holder = JSON.parse(seen);
      holderPid = Number.isInteger(holder?.pid) && holder.pid > 0 ? holder.pid : null;
      if (holderPid !== null && !pidAlive(holderPid)) stale = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_UNREADABLE_STALE_MS) stale = true;
      } catch { /* vanished between attempts: retry */ }
    }
    if (stale) {
      // Only the lock that was judged stale may go: another waiter may have
      // broken it and taken it in the meantime, and its fresh lock must stay.
      try {
        if (seen === null || fs.readFileSync(file, "utf-8") === seen) fs.unlinkSync(file);
      } catch { /* raced */ }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`mirror lock ${file} is held${holderPid ? ` by pid ${holderPid}` : ""}`);
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf-8")).token === token) fs.unlinkSync(file);
    } catch { /* someone broke it: nothing to release */ }
  }
}

// ---------------------------------------------------------------------------
// Merges (pure)
// ---------------------------------------------------------------------------

/** The host's own codecast blocks, verbatim, in file order. */
export function ownedBlocks(text: string): string[] {
  return findAllOwnedSections(text).map((r) => text.slice(r.start, r.end));
}

/**
 * user portion (laptop, stripped again defensively) then each of the host's
 * own owned blocks exactly once, original order.
 */
export function composeInstructionFile(userPortion: string, currentHostText: string | null): string {
  const user = stripOwnedSections(userPortion).replace(/\s+$/, "");
  const blocks = currentHostText ? ownedBlocks(currentHostText) : [];
  const tail = blocks.map((b) => b.replace(/\n+$/, "\n")).join("\n");
  if (!tail) return user ? `${user}\n` : "";
  return user ? `${user}\n\n${tail}` : tail;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Laptop over host, key by key; arrays and scalars are replaced. */
export function deepMerge(current: unknown, mirrored: unknown): unknown {
  if (isPlainObject(current) && isPlainObject(mirrored)) {
    const out: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(mirrored)) out[k] = deepMerge(current[k], v);
    return out;
  }
  return mirrored === undefined ? current : mirrored;
}

type HookEntry = { command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };

/**
 * Re-pin the host's codecast hook entries into a (laptop-stripped) hooks
 * table: per event, the host's own groups first — each kept in its own
 * shape (installHookScript's `matcher: ""` group, orchestration's
 * matcher-less and `implementer|reviewer|critic` groups), reduced to its
 * codecast entries — then the laptop's groups. Keeping the shapes is what
 * lets the host's installers find their entries again and a second apply
 * reproduce the file byte for byte.
 */
export function pinCodecastHooks(mirroredHooks: unknown, currentHooks: unknown, home: string): Record<string, HookGroup[]> | undefined {
  const laptop: Record<string, HookGroup[]> = dropCodecastHooks(mirroredHooks, home) ?? {};
  const out: Record<string, HookGroup[]> = {};
  if (isPlainObject(currentHooks)) {
    for (const [event, groups] of Object.entries(currentHooks)) {
      if (!Array.isArray(groups)) continue;
      const own: HookGroup[] = [];
      for (const g of groups as HookGroup[]) {
        const entries = (g?.hooks ?? []).filter((h) => isCodecastHookCommand(h?.command, home));
        if (entries.length) own.push({ ...g, hooks: entries });
      }
      if (own.length) out[event] = own;
    }
  }
  for (const [event, groups] of Object.entries(laptop)) out[event] = [...(out[event] ?? []), ...groups];
  return Object.keys(out).length ? out : undefined;
}

/**
 * settings.json for the host: deepMerge(current, mirrored), then the host's
 * pins — its codecast hooks, the persistence env, any env key the agent-auth
 * manifest lists, `model`, `skipDangerousModePermissionPrompt`.
 */
export function mergeClaudeSettings(
  mirrored: unknown,
  current: unknown,
  home: string,
  pinnedEnvKeys: readonly string[] = [],
): Record<string, unknown> {
  const cur = isPlainObject(current) ? current : {};
  const mir = isPlainObject(mirrored) ? mirrored : {};
  const merged = deepMerge(cur, mir) as Record<string, unknown>;
  const hooks = pinCodecastHooks(mir.hooks, cur.hooks, home);
  if (hooks) merged.hooks = hooks; else delete merged.hooks;
  const env: Record<string, unknown> = isPlainObject(merged.env) ? { ...merged.env } : {};
  const curEnv = isPlainObject(cur.env) ? cur.env : {};
  env[FORCE_PERSISTENCE_VAR] = "1";
  for (const key of pinnedEnvKeys) if (curEnv[key] !== undefined) env[key] = curEnv[key];
  merged.env = env;
  if (cur.model !== undefined) merged.model = cur.model;
  if (cur.skipDangerousModePermissionPrompt !== undefined) merged.skipDangerousModePermissionPrompt = cur.skipDangerousModePermissionPrompt;
  return merged;
}

/** codex hooks.json: the laptop's entries plus the host's codecast ones. */
export function mergeCodexHooks(mirrored: unknown, current: unknown, home: string): Record<string, unknown> {
  const cur = isPlainObject(current) ? current : {};
  const mir = isPlainObject(mirrored) ? mirrored : {};
  const out: Record<string, unknown> = { ...cur, ...mir };
  const hooks = pinCodecastHooks(mir.hooks, cur.hooks, home);
  if (hooks) out.hooks = hooks; else delete out.hooks;
  return out;
}

function tableFirst(name: string | null): string {
  return name === null ? "" : tableFirstSegment(name);
}

/** Trust tables belong to each host. */
const HOST_OWNED_CODEX_TABLES = ["projects"];

export function mergeCodexToml(mirrored: string, current: string | null): string {
  const mir = splitTomlTables(mirrored).filter((t) => !HOST_OWNED_CODEX_TABLES.includes(tableFirst(t.name)));
  const cur = current ? splitTomlTables(current) : [];
  const hostProjects = cur.filter((t) => HOST_OWNED_CODEX_TABLES.includes(tableFirst(t.name)));
  const hostFeatures = cur.find((t) => t.name === "features");
  const hooksLine = hostFeatures?.lines.find((l) => /^\s*hooks\s*=/.test(l));
  if (hooksLine !== undefined) {
    let features = mir.find((t) => t.name === "features");
    if (!features) {
      features = { name: "features", header: "[features]", lines: [] };
      mir.push(features);
    }
    features.lines = features.lines.filter((l) => !/^\s*hooks\s*=/.test(l));
    // Keep the table's trailing blank line after the hooks line.
    const trailing = features.lines.length && features.lines[features.lines.length - 1] === "" ? features.lines.pop() : undefined;
    features.lines.push(hooksLine);
    if (trailing !== undefined) features.lines.push(trailing);
  }
  const out: TomlTable[] = [...mir];
  for (const p of hostProjects) {
    const prev = out[out.length - 1];
    if (prev && prev.lines[prev.lines.length - 1] !== "") prev.lines.push("");
    out.push(p);
  }
  let text = joinTomlTables(out).replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  if (text && !text.endsWith("\n")) text += "\n";
  return text;
}

/** ~/.gitconfig without the marker block (and the blank line that separated it). */
export function stripGitconfigBlock(current: string): string {
  const start = current.indexOf(GITCONFIG_BLOCK_START);
  const end = current.indexOf(GITCONFIG_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return current;
  const after = current.slice(end + GITCONFIG_BLOCK_END.length).replace(/^\n/, "");
  const before = current.slice(0, start).replace(/\n+$/, "\n");
  return before + after;
}

/** ~/.gitconfig: replace or append the marker block; everything outside is untouched. */
export function mergeGitconfig(block: string, current: string | null): string {
  const body = block.replace(/\s+$/, "");
  const ours = `${GITCONFIG_BLOCK_START}\n${body}${body ? "\n" : ""}${GITCONFIG_BLOCK_END}\n`;
  const text = current ?? "";
  const start = text.indexOf(GITCONFIG_BLOCK_START);
  const end = text.indexOf(GITCONFIG_BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const after = text.slice(end + GITCONFIG_BLOCK_END.length).replace(/^\n/, "");
    return text.slice(0, start) + ours + after;
  }
  if (!text) return ours;
  return `${text.replace(/\n*$/, "\n")}\n${ours}`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function ensureDirChain(root: string, relDir: string): string {
  let dir = root;
  for (const part of relDir.split("/").filter(Boolean)) {
    dir = path.join(dir, part);
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!st) fs.mkdirSync(dir, { mode: 0o700 });
    else if (st.isSymbolicLink()) throw new Error("destination directory is a symlink");
    else if (!st.isDirectory()) throw new Error("destination directory is not a directory");
  }
  return dir;
}

/** Atomic write with receiveFile's rules: no symlinked component, regular-file destination only. */
export function writeMirroredFile(root: string, rel: string, bytes: Buffer, mode: "0600" | "0700"): void {
  const dir = ensureDirChain(root, path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel));
  const dest = path.join(root, rel);
  const old = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (old && !old.isFile()) throw new Error("destination is not a regular file");
  const temp = fs.mkdtempSync(path.join(dir, ".cast-mirror-"));
  try {
    const file = path.join(temp, "file");
    fs.writeFileSync(file, bytes, { mode: mode === "0700" ? 0o700 : 0o600 });
    fs.chmodSync(file, mode === "0700" ? 0o700 : 0o600);
    fs.renameSync(file, dest);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function readIfRegular(abs: string): Buffer | null {
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  return fs.readFileSync(abs);
}

const hashChunk = Buffer.allocUnsafe(64 * 1024);
function hashIfRegular(abs: string): string | null {
  if (!fs.lstatSync(abs, { throwIfNoEntry: false })?.isFile()) return null;
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const hash = createHash("sha256");
    for (;;) {
      const size = fs.readSync(fd, hashChunk, 0, hashChunk.length, null);
      if (!size) return hash.digest("hex");
      hash.update(hashChunk.subarray(0, size));
    }
  } finally { fs.closeSync(fd); }
}

function checkDestination(home: string, rel: string): void {
  assertSafePath(rel);
  let dir = home;
  for (const part of rel.split("/")) {
    dir = path.join(dir, part);
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw new Error("destination is a symlink");
  }
}

function destinationRelative(home: string, rel: string, kind?: MirrorKind): string {
  assertSafePath(rel);
  if (kind !== "claude-md" && kind !== "agents-md") { checkDestination(home, rel); return rel; }
  const file = path.join(home, rel);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) { checkDestination(home, rel); return rel; }
  const target = path.relative(home, path.resolve(path.dirname(file), fs.readlinkSync(file)));
  assertSafePath(target);
  if (path.dirname(target) !== path.dirname(rel) || !/^(?:AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI|GROK|OPENCODE)\.md$/i.test(path.basename(target))) throw new Error("instruction alias leaves its directory");
  checkDestination(home, target);
  return target;
}

function projectAliasDestination(home: string, rel: string, project: string, expectedTarget?: string): string {
  assertSafePath(rel);
  assertSafePath(project);
  if (!rel.startsWith(`${project}/`)) throw new Error("alias is outside its registered project");
  checkDestination(home, path.dirname(rel));
  const file = path.join(home, rel);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("project alias is missing or replaced");
  const target = path.relative(home, path.resolve(path.dirname(file), fs.readlinkSync(file)));
  assertSafePath(target);
  if (!target.startsWith(`${project}/`)) throw new Error("alias target leaves its registered project");
  if (expectedTarget && target !== expectedTarget) throw new Error("project alias target changed");
  checkDestination(home, target);
  return target;
}

export function verifyMirrorStamp(home: string): MirrorStamp | null {
  const stamp = readStamp(home);
  if (!stamp) return null;
  let complete = stamp.complete === true;
  const overrides = readHostMcpOverrides(home);
  if (stamp.mcp_overrides_hash || Object.keys(overrides.codex).length || Object.keys(overrides.claude).length) {
    if (stamp.mcp_overrides_hash !== sha256(JSON.stringify(overrides))) complete = false;
  }
  for (const [rel, info] of Object.entries(stamp.files)) {
    try {
      assertSafePath(rel);
      if (path.dirname(rel) !== ".") checkDestination(home, path.dirname(rel));
      if (info.removed) {
        if (fs.lstatSync(path.join(home, rel), { throwIfNoEntry: false })) complete = false;
        continue;
      }
      const dest = info.satisfied_alias ? projectAliasDestination(home, rel, info.satisfied_alias.project, info.satisfied_alias.target) : destinationRelative(home, rel, info.kind);
      if (info.alias && info.alias !== dest) complete = false;
      const hash = info.kind === "claude-mcp" && info.mcp_fields
        ? claudeMcpWritten(fs.readFileSync(path.join(home, dest)), info)
        : hashIfRegular(path.join(home, dest));
      const mode = fs.statSync(path.join(home, dest)).mode & 0o777;
      if (info.host_edited || hash !== info.written || mode !== Number.parseInt(info.mode, 8)) complete = false;
    } catch {
      complete = false;
    }
  }
  return { ...stamp, hash: complete ? stamp.hash : "", complete };
}

/** After a prune: drop directories the removal emptied, up to (not including) the managed root. */
function removeEmptyParents(home: string, rel: string, root: string): void {
  let dir = path.posix.dirname(rel);
  while (dir !== root && dir !== "." && dir.startsWith(`${root}/`)) {
    try {
      if (fs.readdirSync(path.join(home, dir)).length) return;
      fs.rmdirSync(path.join(home, dir));
    } catch {
      return;
    }
    dir = path.posix.dirname(dir);
  }
}

function sameHome(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "") || "/";
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  home: string;
  /** user_id from the host's ~/.codecast/config.json (undefined = unprovisioned). */
  configUserId: string | undefined;
  previousStamp: MirrorStamp | null;
  /** Re-inject codecast's own content after the merge (default: runHostRefresh). */
  refresh?: (home: string) => void;
  now?: () => Date;
  /** Env keys the agent-auth push owns on this host (default: read the manifest). */
  pinnedEnvKeys?: readonly string[];
}

export function readMirroredEnvKeys(home: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, MIRRORED_ENV_MANIFEST_REL), "utf-8"));
    const keys = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.keys) ? parsed.keys : Object.keys(parsed ?? {});
    return keys.filter((k: unknown): k is string => typeof k === "string");
  } catch {
    return [];
  }
}

/** Final host bytes for one file, by kind, from the host's current file. */
function reconcileFields(previous: unknown, current: unknown, incoming: unknown, conflict: () => void): unknown {
  if (previous === undefined && isPlainObject(current) && isPlainObject(incoming)) return deepMerge(current, incoming);
  if (isPlainObject(previous) && isPlainObject(current) && (incoming === undefined || isPlainObject(incoming))) {
    const next = isPlainObject(incoming) ? incoming : {};
    const out: Record<string, unknown> = { ...current };
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const value = reconcileFields(previous[key], current[key], next[key], conflict);
      if (value === undefined) delete out[key]; else Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    }
    return Object.keys(out).length || incoming !== undefined ? out : undefined;
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (previous !== undefined && !same(current, previous) && !same(current, incoming)) {
    conflict();
    return current;
  }
  return incoming === undefined && previous === undefined ? current : incoming;
}

function reconcileToml(previous: string, current: string, incoming: string, conflict: () => void): string {
  const parse = (text: string) => Object.fromEntries(splitTomlTables(text).map((table) => {
    const fields: Record<string, string> = {};
    let key = "";
    for (const line of table.lines) {
      const match = /^\s*([A-Za-z0-9_."'-]+)\s*=/.exec(line);
      if (match) key = match[1]!;
      fields[key] = (fields[key] ?? "") + line + "\n";
    }
    for (const name of Object.keys(fields)) {
      fields[name] = fields[name]!.trimEnd();
      if (!fields[name]) delete fields[name];
    }
    return [table.header ?? "", fields];
  }));
  const clean = (text: string) => {
    const tables = splitTomlTables(text).filter((t) => !HOST_OWNED_CODEX_TABLES.includes(tableFirst(t.name)));
    for (const table of tables) if (table.name === "features") table.lines = table.lines.filter((l) => !/^\s*hooks\s*=/.test(l));
    return parse(joinTomlTables(tables));
  };
  const result = reconcileFields(clean(previous), clean(current), clean(incoming), conflict) as Record<string, Record<string, string>>;
  return Object.entries(result).map(([header, fields]) => [header, ...Object.values(fields)].filter(Boolean).join("\n")).filter(Boolean).join("\n\n") + "\n";
}

function mcpSourceServers(text: string, codex: boolean): Record<string, McpSourceServer> {
  const value = codex ? Bun.TOML.parse(text) : JSON.parse(text || "{}");
  const servers = (value as Record<string, any>)[codex ? "mcp_servers" : "mcpServers"];
  if (!isPlainObject(servers)) return {};
  return Object.fromEntries(Object.entries(servers).filter(([, server]) => isPlainObject(server) && typeof server.command === "string").map(([name, server]) => [name, { command: (server as any).command, ...(Array.isArray((server as any).args) ? { args: (server as any).args } : {}) }]));
}

function codexMcpEnabled(text: string, names: readonly string[], source?: string): string {
  if (!names.length) return text;
  const values = source === undefined ? undefined : (Bun.TOML.parse(source) as any).mcp_servers;
  const tables = splitTomlTables(text);
  const found = new Set<string>();
  for (const table of tables) {
    if (!table.header || tableFirst(table.name) !== "mcp_servers") continue;
    const parsed = Bun.TOML.parse(`${table.header}\n__mirror_probe = true\n`) as any;
    const name = Object.keys(parsed.mcp_servers ?? {}).find((key) => parsed.mcp_servers[key]?.__mirror_probe === true);
    if (!name || !names.includes(name)) continue;
    found.add(name);
    table.lines = table.lines.filter((line) => !/^\s*(?:enabled|"enabled"|'enabled')\s*=/.test(line));
    const enabled = source === undefined ? false : values?.[name]?.enabled;
    if (enabled !== undefined) table.lines.unshift(`enabled = ${JSON.stringify(enabled)}`);
  }
  if (source === undefined && names.some((name) => !found.has(name))) throw new Error("host MCP override requires an explicit mcp_servers table");
  return joinTomlTables(tables);
}

function claudeMcpSections(value: Record<string, any>): Array<[string | null, Record<string, any>]> {
  return [
    ...(isPlainObject(value.mcpServers) ? [[null, value.mcpServers] as [null, Record<string, any>]] : []),
    ...Object.entries(value.projects ?? {}).flatMap(([root, project]) => isPlainObject(project) && isPlainObject(project.mcpServers) ? [[root, project.mcpServers] as [string, Record<string, any>]] : []),
  ];
}

function claudeMcpFields(text: string, previous?: StampFile): string[][] {
  const fields = new Map((previous?.mcp_fields ?? []).map((field) => [JSON.stringify(field), field]));
  const visit = (value: unknown, field: string[]) => {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...field, key]);
    } else fields.set(JSON.stringify(field), field);
  };
  for (const source of [previous?.source, text]) if (source) {
    for (const [root, servers] of claudeMcpSections(JSON.parse(source))) {
      for (const [name, server] of Object.entries(servers)) visit(server, [...(root === null ? [] : ["projects", root]), "mcpServers", name]);
    }
  }
  const current = JSON.parse(text);
  return [...fields.entries()].filter(([, field]) => {
    const value = mcpFieldValue(current, field);
    return value[0] !== field.length || !isPlainObject(value[1]);
  }).sort(([a], [b]) => a.localeCompare(b)).map(([, field]) => field);
}

function mcpFieldValue(value: unknown, field: string[]): unknown[] {
  for (const [index, key] of field.entries()) {
    if (value === undefined) return [];
    if (!isPlainObject(value)) return [index, value];
    value = Object.hasOwn(value, key) ? value[key] : undefined;
  }
  return value === undefined ? [] : [field.length, value];
}

function claudeMcpWritten(bytes: Buffer, info: Pick<StampFile, "mcp_fields" | "mcp_disabled">): string {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!isPlainObject(value)) throw new Error("invalid Claude MCP host state");
  const fields = [...(info.mcp_fields ?? []), ...(info.mcp_disabled ?? []).map((pin) => {
    const [root, name] = JSON.parse(pin);
    return [...(root === null ? [] : ["projects", root]), "mcpServers", name];
  })];
  return sha256(JSON.stringify(fields.map((field) => mcpFieldValue(value, field)), (_key, item) =>
    isPlainObject(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));
}

function claudeMcpPins(text: string, overrides: HostMcpOverrides): { pinned: string[]; next: HostMcpOverrides } {
  const pinned: string[] = [];
  const names = new Set<string>();
  for (const [root, servers] of claudeMcpSections(JSON.parse(text))) {
    for (const name of maskPins(overrides, "claude", mcpSourceServers(JSON.stringify({ mcpServers: servers }), false)).pinned) {
      pinned.push(JSON.stringify([root, name]));
      names.add(name);
    }
  }
  const next = structuredClone(overrides);
  for (const name of Object.keys(next.claude)) if (!names.has(name)) delete next.claude[name];
  return { pinned, next };
}

export function finalBytes(file: ParsedFile, current: Buffer | null, home: string, pinnedEnvKeys: readonly string[], previous?: StampFile, conflict: () => void = () => {}, overrides?: HostMcpOverrides): Buffer {
  if (VERBATIM_KINDS.includes(file.kind) && !(overrides && path.basename(file.path) === ".mcp.json")) return file.bytes;
  const text = file.bytes.toString("utf-8");
  const cur = current ? current.toString("utf-8") : null;
  // The host's own installers (installHookScript, installStableHook*) write
  // settings.json with 4-space and hooks.json with 2-space indent and no
  // trailing newline; matching them is what makes a second apply a no-op.
  const parse = (s: string | null) => s === null ? null : JSON.parse(s);
  const ordered = (v: unknown, old: unknown): unknown => {
    if (!isPlainObject(v) || !isPlainObject(old)) return v;
    return Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(v)])].filter((k) => k in v).map((k) => [k, ordered(v[k], old[k])]));
  };
  const json = (v: unknown, indent: number) => Buffer.from(JSON.stringify(ordered(v, parse(cur)), null, indent));
  switch (file.kind) {
    case "claude-mcp": {
      const original = parse(cur) ?? {};
      const masked = structuredClone(original);
      const prior = previous?.source ? parse(previous.source) : {};
      const incoming = parse(text);
      for (const field of previous?.mcp_fields ?? []) {
        if (!mcpFieldValue(prior, field).length && !mcpFieldValue(incoming, field).length && mcpFieldValue(original, field).length) conflict();
      }
      for (const [root, servers] of claudeMcpSections(prior)) {
        for (const [name, server] of Object.entries(servers)) {
          if (!previous?.mcp_disabled?.includes(JSON.stringify([root, name]))) continue;
          const section = root === null ? masked : ((masked.projects ??= {})[root] ??= {});
          if (!Object.hasOwn(section.mcpServers ?? {}, name)) (section.mcpServers ??= {})[name] = server;
        }
      }
      const merged = reconcileFields(prior, masked, incoming, conflict) as Record<string, any>;
      const pins = overrides ? claudeMcpPins(text, overrides).pinned : [];
      for (const [root, servers] of claudeMcpSections(merged)) {
        for (const name of Object.keys(servers)) if (pins.includes(JSON.stringify([root, name]))) delete servers[name];
      }
      return json(merged, 2);
    }
    case "claude-md":
    case "agents-md": {
      if (previous?.source !== undefined && cur !== null && stripOwnedSections(cur).trim() !== previous.source.trim() && stripOwnedSections(cur).trim() !== text.trim()) {
        conflict();
        return current!;
      }
      return Buffer.from(composeInstructionFile(text, cur));
    }
    case "claude-settings":
    case "codex-hooks": {
      if (previous?.source === undefined) return file.kind === "claude-settings"
        ? json(mergeClaudeSettings(parse(text), parse(cur), home, pinnedEnvKeys), 4)
        : json(mergeCodexHooks(parse(text), parse(cur), home), 2);
      const original = parse(cur) ?? {};
      const clean = (value: unknown) => {
        const obj = isPlainObject(value) ? structuredClone(value) : {};
        const hooks = dropCodecastHooks(obj.hooks, home);
        if (hooks) obj.hooks = hooks; else delete obj.hooks;
        if (file.kind === "claude-settings") {
          delete obj.model;
          delete obj.skipDangerousModePermissionPrompt;
          if (isPlainObject(obj.env)) {
            for (const key of [FORCE_PERSISTENCE_VAR, ...pinnedEnvKeys]) delete obj.env[key];
            if (!Object.keys(obj.env).length) delete obj.env;
          }
        }
        return obj;
      };
      const merged = reconcileFields(clean(parse(previous.source)), clean(original), clean(parse(text)), conflict) as Record<string, unknown>;
      const hooks = pinCodecastHooks(merged.hooks, original.hooks, home);
      if (hooks) merged.hooks = hooks; else delete merged.hooks;
      if (file.kind === "claude-settings") {
        const env = isPlainObject(merged.env) ? merged.env : {};
        env[FORCE_PERSISTENCE_VAR] = "1";
        for (const key of pinnedEnvKeys) if (original.env?.[key] !== undefined) env[key] = original.env[key];
        merged.env = env;
        for (const key of ["model", "skipDangerousModePermissionPrompt"]) if (original[key] !== undefined) merged[key] = original[key];
      }
      return json(merged, file.kind === "claude-settings" ? 4 : 2);
    }
    case "codex-toml": {
      const pins = overrides ? maskPins(overrides, "codex", mcpSourceServers(text, true)).pinned : [];
      const masked = codexMcpEnabled(cur ?? "", [...new Set([...Object.keys(overrides?.codex ?? {}), ...(previous?.mcp_disabled ?? [])])], previous?.source ?? text);
      const merged = mergeCodexToml(reconcileToml(previous?.source ?? "", masked, text, conflict), cur);
      return Buffer.from(codexMcpEnabled(merged, pins));
    }
    case "gitconfig":
      if (previous?.source !== undefined && cur !== null) {
        const start = cur.indexOf(GITCONFIG_BLOCK_START);
        const end = cur.indexOf(GITCONFIG_BLOCK_END);
        const body = start !== -1 && end > start ? cur.slice(start + GITCONFIG_BLOCK_START.length, end).trim() : "";
        if (body !== previous.source.trim() && body !== text.trim()) { conflict(); return current!; }
      }
      return Buffer.from(mergeGitconfig(text, cur));
    default:
      if (overrides && (file.path === ".claude.json" || path.basename(file.path) === ".mcp.json")) {
        const pins = maskPins(overrides, "claude", mcpSourceServers(text, false)).pinned;
        if (pins.length) {
          const config = JSON.parse(text);
          for (const name of pins) delete config.mcpServers[name];
          return Buffer.from(JSON.stringify(config, null, 2) + "\n");
        }
      }
      return file.bytes;
  }
}

/**
 * Apply a parsed bundle under `home`. Call inside withMirrorLock. Guards
 * first (nothing is written on a refusal), then per-file merge + write,
 * prune, refresh, stamp.
 */
export async function applyMirrorBundle(bundle: ParsedBundle, opts: ApplyOptions): Promise<ApplyResult> {
  const { home } = opts;
  const now = opts.now ?? (() => new Date());
  const result: ApplyResult = { hash: bundle.hash, applied: [], unchanged: 0, host_edited: [], pruned: [], errors: [] };
  const src = bundle.header.source;

  if (!opts.configUserId) return { ...result, refused: "unprovisioned" };
  if (src.user_id !== opts.configUserId) return { ...result, refused: "other_user" };
  // Remapped for another home: every absolute path in it would be dead here.
  if (!sameHome(bundle.header.target_home, home)) return { ...result, refused: "other_home" };
  const prev = opts.previousStamp;
  if (prev && prev.source_device_id && prev.source_device_id !== src.device_id && !bundle.header.take_over) {
    return { ...result, refused: "other_device" };
  }
  const projectRoots = [...(bundle.header.project_roots ?? [])].sort((a, b) => b.length - a.length);
  for (const root of projectRoots) {
    try {
      checkDestination(home, root);
      if (!fs.statSync(path.join(home, root)).isDirectory()) throw new Error("not a directory");
    } catch (err) {
      result.errors.push({ path: root, error: "registered project target is missing or unsafe; retire or repair its registration" });
      if ((err as NodeJS.ErrnoException).code === "ENOENT") (result.retired_projects ??= []).push(root);
    }
  }
  if (result.errors.length) return result;

  const pinned = opts.pinnedEnvKeys ?? readMirroredEnvKeys(home);
  const overrides = readHostMcpOverrides(home);
  let nextOverrides = overrides;
  const stampFiles: Record<string, StampFile> = {};
  const manifest = new Set(bundle.files.map((f) => f.path));
  const gitTrees = new Map<string, Map<string, { hash: string; mode: string }>>();

  for (const file of bundle.files) {
    if (isCodecastOwnedHomePath(file.path)) { result.errors.push({ path: file.path, error: "codecast-owned path" }); continue; }
    try {
      assertMirrorFileContent(file);
      const before = prev?.files[file.path]?.removed ? undefined : prev?.files[file.path];
      const project = projectRoots.find((root) => file.path.startsWith(`${root}/`));
      if (file.kind === "verbatim" && project && (before?.satisfied_alias || fs.lstatSync(path.join(home, file.path), { throwIfNoEntry: false })?.isSymbolicLink())) {
        const target = projectAliasDestination(home, file.path, project, before?.satisfied_alias?.target);
        const abs = path.join(home, target);
        if (hashIfRegular(abs) !== file.sha256 || (fs.statSync(abs).mode & 0o777) !== Number.parseInt(file.mode, 8)) throw new Error("project alias target bytes or mode differ from mirror");
        stampFiles[file.path] = { sha: file.sha256, written: file.sha256, kind: file.kind, mode: file.mode, satisfied_alias: { project, target } };
        result.unchanged++;
        continue;
      }
      const dest = destinationRelative(home, file.path, file.kind);
      const abs = path.join(home, dest);
      const current = VERBATIM_KINDS.includes(file.kind) && hashIfRegular(abs) === file.sha256 ? file.bytes : readIfRegular(abs);
      if (before && before.source === undefined && !VERBATIM_KINDS.includes(file.kind) && before.sha !== file.sha256) throw new Error("previous mirror lacks field ownership; restore the previous source once before changing it");
      let cleanTracked = false;
      if (project && !before && current && !current.equals(finalBytes(file, current, home, pinned, undefined, undefined, overrides))) {
        if (!gitTrees.has(project)) gitTrees.set(project, await cleanTrackedFiles(path.join(home, project)));
        cleanTracked = matchesGitBlob(current, fs.statSync(abs).mode, gitTrees.get(project)!.get(path.posix.relative(project, dest)));
      }
      if (project && !before && current && !cleanTracked && !current.equals(finalBytes(file, current, home, pinned, undefined, undefined, overrides))) {
        result.host_edited.push(file.path);
        stampFiles[file.path] = { sha: file.sha256, written: sha256(finalBytes(file, current, home, pinned, undefined, undefined, overrides)), kind: file.kind, mode: file.mode, host_edited: true, ...(!VERBATIM_KINDS.includes(file.kind) ? { source: file.bytes.toString("utf8") } : {}) };
        continue;
      }
      if (before && current && VERBATIM_KINDS.includes(file.kind)) {
        const hostSha = sha256(current);
        if (hostSha !== before.written && !current.equals(file.bytes)) {
          result.host_edited.push(file.path);
          stampFiles[file.path] = { sha: before.sha, written: before.written, mode: before.mode, kind: file.kind, host_edited: true };
          continue;
        }
      }
      let conflicted = false;
      const bytes = finalBytes(file, current, home, pinned, before, () => { conflicted = true; }, overrides);
      const mcp = file.kind === "codex-toml" ? maskPins(nextOverrides, "codex", mcpSourceServers(file.bytes.toString("utf8"), true))
        : file.kind === "claude-mcp" ? claudeMcpPins(file.bytes.toString("utf8"), nextOverrides) : undefined;
      if (file.path === ".codex/config.toml" && mcp) nextOverrides = mcp.next;
      if (file.path === ".claude.json" && mcp) nextOverrides = mcp.next;
      if (conflicted) result.host_edited.push(file.path);
      const sameBytes = current !== null && current.equals(bytes);
      let sameMode = true;
      if (current !== null) {
        const st = fs.statSync(abs);
        sameMode = (st.mode & 0o777) === (file.mode === "0700" ? 0o700 : 0o600);
      }
      if (sameBytes && sameMode) result.unchanged++;
      else {
        writeMirroredFile(home, dest, bytes, file.mode);
        result.applied.push(file.path);
      }
      stampFiles[file.path] = {
        sha: file.sha256, written: sha256(bytes), mode: file.mode, kind: file.kind,
        ...(!VERBATIM_KINDS.includes(file.kind) ? { source: conflicted ? before?.source : file.bytes.toString("utf-8") } : {}),
        ...(conflicted ? { host_edited: true as const } : {}),
        ...(dest !== file.path ? { alias: dest } : {}),
        ...(mcp ? { mcp_disabled: mcp.pinned } : {}),
      };
      if (file.kind === "claude-mcp") {
        stampFiles[file.path]!.mcp_fields = claudeMcpFields(file.bytes.toString("utf8"), before);
        stampFiles[file.path]!.written = claudeMcpWritten(bytes, stampFiles[file.path]!);
      }
    } catch (err) {
      if (prev?.files[file.path]) stampFiles[file.path] = prev.files[file.path]!;
      result.errors.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (prev) {
    const roots = [...new Set([...bundle.header.managed_roots, ...prev.managed_roots])];
    for (const [rel, info] of Object.entries(prev.files)) {
      if (manifest.has(rel) || isCodecastOwnedHomePath(rel)) continue;
      if (bundle.header.unmanaged_roots?.some((root) => rel === root || rel.startsWith(`${root}/`))) continue;
      const kind = info.kind ?? "verbatim";
      let dest = rel;
      let abs = path.join(home, rel);
      let current: Buffer | null;
      try {
        if (info.removed) {
          assertSafePath(rel);
          if (path.dirname(rel) !== ".") checkDestination(home, path.dirname(rel));
          if (fs.lstatSync(abs, { throwIfNoEntry: false })) result.host_edited.push(rel);
          stampFiles[rel] = info;
          continue;
        }
        if (info.satisfied_alias) {
          assertSafePath(rel);
          checkDestination(home, path.dirname(rel));
          if (!fs.lstatSync(abs, { throwIfNoEntry: false })) { stampFiles[rel] = { ...info, removed: true }; continue; }
          const target = projectAliasDestination(home, rel, info.satisfied_alias.project, info.satisfied_alias.target);
          const targetAbs = path.join(home, target);
          if (!(stampFiles[target]?.removed && !fs.lstatSync(targetAbs, { throwIfNoEntry: false }))
            && (hashIfRegular(targetAbs) !== info.written || (fs.statSync(targetAbs).mode & 0o777) !== Number.parseInt(info.mode, 8))) {
            stampFiles[rel] = info; result.host_edited.push(rel); continue;
          }
          fs.unlinkSync(abs);
          stampFiles[rel] = { ...info, removed: true };
          result.pruned.push(rel);
          continue;
        }
        dest = destinationRelative(home, rel, info.kind);
        if (info.alias) {
          const entry = fs.lstatSync(abs, { throwIfNoEntry: false });
          if (!entry) stampFiles[rel] = { ...info, removed: true };
          else if (entry.isSymbolicLink() && dest === info.alias) {
            fs.unlinkSync(abs);
            stampFiles[rel] = { ...info, removed: true };
            result.pruned.push(rel);
          } else { stampFiles[rel] = info; result.host_edited.push(rel); }
          continue;
        }
        abs = path.join(home, dest);
        current = readIfRegular(abs);
      } catch (err) {
        stampFiles[rel] = info;
        result.errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (current === null) { stampFiles[rel] = { ...info, removed: true }; continue; }
      if (kind === "gitconfig") {
        try {
          const text = current.toString("utf8");
          const start = text.indexOf(GITCONFIG_BLOCK_START);
          const end = text.indexOf(GITCONFIG_BLOCK_END);
          const body = start !== -1 && end > start ? text.slice(start + GITCONFIG_BLOCK_START.length, end).trim() : "";
          if (info.source !== undefined && body !== info.source.trim()) { result.host_edited.push(rel); stampFiles[rel] = info; continue; }
          const stripped = stripGitconfigBlock(current.toString("utf-8"));
          if (stripped !== current.toString("utf-8")) {
            if (stripped.trim()) writeMirroredFile(home, rel, Buffer.from(stripped), info.mode); else fs.unlinkSync(abs);
            result.pruned.push(rel);
          }
          stampFiles[rel] = { ...info, written: sha256(stripped), ...(stripped.trim() ? {} : { removed: true as const }), source: "" };
        } catch (err) {
          stampFiles[rel] = info;
          result.errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      if (!VERBATIM_KINDS.includes(kind)) {
        try {
          if (info.source === undefined) throw new Error("previous mirror lacks field ownership; restore the source once before removing it");
          let conflicted = false;
          const empty = kind === "claude-settings" || kind === "codex-hooks" || kind === "claude-mcp" ? "{}" : "";
          const bytes = finalBytes({ path: rel, kind, mode: info.mode, size: 0, sha256: sha256(empty), bytes: Buffer.from(empty) }, current, home, pinned, info, () => { conflicted = true; }, overrides);
          if (rel === ".codex/config.toml") nextOverrides = maskPins(nextOverrides, "codex", {}).next;
          if (rel === ".claude.json") nextOverrides = maskPins(nextOverrides, "claude", {}).next;
          if (!bytes.equals(current)) {
            if (bytes.toString().trim()) writeMirroredFile(home, dest, bytes, info.mode); else fs.unlinkSync(abs);
            result.pruned.push(rel);
          }
          if (conflicted) result.host_edited.push(rel);
          stampFiles[rel] = { ...info, written: sha256(bytes), source: conflicted ? info.source : empty, host_edited: conflicted ? true : undefined, ...(!bytes.toString().trim() ? { removed: true as const } : {}) };
          if (kind === "claude-mcp") {
            stampFiles[rel]!.mcp_fields = claudeMcpFields(empty, info);
            stampFiles[rel]!.mcp_disabled = [];
            stampFiles[rel]!.written = claudeMcpWritten(bytes, stampFiles[rel]!);
          }
        } catch (err) {
          stampFiles[rel] = info;
          result.errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      const root = roots.find((r) => rel === r || rel.startsWith(`${r}/`));
      if (!root) continue;
      if (sha256(current) !== info.written) { stampFiles[rel] = info; result.host_edited.push(rel); continue; }
      try {
        fs.unlinkSync(abs);
        result.pruned.push(rel);
        stampFiles[rel] = { ...info, removed: true };
        removeEmptyParents(home, rel, root);
      } catch (err) {
        stampFiles[rel] = info;
        result.errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  try {
    (opts.refresh ?? runHostRefresh)(home);
  } catch (err) {
    result.errors.push({ path: ".codecast", error: `refresh failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  // The post-refresh bytes are what the next apply compares against — except
  // for a host-edited file, whose `written` must stay the mirror's own sha.
  for (const [rel, info] of Object.entries(stampFiles)) {
    if (info.host_edited || info.removed) continue;
    try {
      const dest = info.satisfied_alias ? projectAliasDestination(home, rel, info.satisfied_alias.project, info.satisfied_alias.target) : destinationRelative(home, rel, info.kind);
      if ((fs.statSync(path.join(home, dest)).mode & 0o777) !== Number.parseInt(info.mode, 8)) throw new Error("mode changed during refresh");
      if (VERBATIM_KINDS.includes(info.kind ?? "verbatim")) {
        if (hashIfRegular(path.join(home, dest)) !== info.written) throw new Error("file changed during refresh");
        continue;
      }
      const current = readIfRegular(path.join(home, dest));
      if (!current) throw new Error("file missing after refresh");
      if (info.kind === "claude-mcp" && info.mcp_fields) {
        if (claudeMcpWritten(current, info) !== info.written) throw new Error("mirrored MCP content changed during refresh");
        continue;
      }
      if (info.source !== undefined && info.kind) {
        const bytes = Buffer.from(info.source);
        finalBytes({ path: rel, kind: info.kind, mode: info.mode, size: bytes.length, sha256: sha256(bytes), bytes }, current, home, pinned, info, () => { throw new Error("mirrored content changed during refresh"); }, overrides);
      }
      info.written = sha256(current);
    } catch (err) {
      result.errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (JSON.stringify(nextOverrides) !== JSON.stringify(overrides)) {
    try { writeHostMcpOverrides(home, nextOverrides); }
    catch (err) { result.errors.push({ path: ".codecast/host-mcp-overrides.json", error: err instanceof Error ? err.message : String(err) }); }
  }
  const stamp: MirrorStamp = {
    version: 1,
    hash: result.errors.length || result.host_edited.length ? "" : bundle.hash,
    desired_hash: bundle.hash,
    complete: !result.errors.length && !result.host_edited.length,
    mcp_overrides_hash: sha256(JSON.stringify(readHostMcpOverrides(home))),
    source_device_id: src.device_id,
    source_user_id: src.user_id,
    applied_at: now().toISOString(),
    files: stampFiles,
    managed_roots: [...new Set([...bundle.header.managed_roots, ...(prev?.managed_roots ?? [])])],
  };
  writeMirroredFile(home, MIRROR_STAMP_REL, Buffer.from(JSON.stringify(stamp, null, 2) + "\n"), "0600");
  return result;
}

/**
 * Re-inject codecast's own content: `cast snippets-refresh` out of process
 * (the same entrypoint this process runs from), the stable-context hooks
 * when stable mode is on, and the settings.json persistence pin.
 */
export function runHostRefresh(home: string): void {
  const entry = process.argv[1];
  if (entry) {
    const sourceEntry = /\.(?:[cm]?js|ts)$/.test(entry) && !entry.startsWith("/$bunfs/") && !entry.includes("~BUN/");
    const result = spawnSync(process.execPath, [...(sourceEntry ? [entry] : []), "snippets-refresh"], {
      env: { ...process.env, HOME: home, CODECAST_NO_AUTO_UPDATE: "1" }, stdio: "ignore", timeout: 120_000,
    });
    if (result.error || result.status !== 0) throw new Error(`snippets-refresh failed (${result.status ?? result.error?.message ?? "signal"})`);
  }
  let stableMode: string | undefined;
  try { stableMode = JSON.parse(fs.readFileSync(path.join(home, ".codecast", "config.json"), "utf-8"))?.stable_mode; } catch { /* no config */ }
  if (stableMode === "solo" || stableMode === "team") {
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      installAllStableHooks();
    } finally {
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    }
  }
  ensureClaudeSettingsPersistence(home);
}

// ---------------------------------------------------------------------------
// Staging mode (`--into <dir>`): the workspace copy path's batched receiver
// ---------------------------------------------------------------------------

export interface StagingResult {
  copied: string[];
  errors: Array<{ path: string; error: string }>;
}

/** Write every file verbatim under `into` with receiveFile's rules. No lock, stamp or refresh. */
export function applyStagingBundle(bundle: ParsedBundle, opts: { into: string }): StagingResult {
  const out: StagingResult = { copied: [], errors: [] };
  for (const f of bundle.files) {
    try {
      writeMirroredFile(opts.into, f.path, f.bytes, f.mode);
      out.copied.push(f.path);
    } catch (err) {
      out.errors.push({ path: f.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
