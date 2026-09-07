/**
 * Host side of the home mirror: `cast cloud mirror-apply --stdin`.
 *
 * Merges, never overwrites, what the host itself owns:
 *   - CLAUDE.md / AGENTS.md: the laptop's user portion followed by the host's
 *     own codecast sections verbatim, then `cast snippets-refresh` re-injects
 *     whatever the host has enabled (idempotent, byte-compared);
 *   - settings.json: deep merge, laptop over host, with the host's codecast
 *     hook entries, persistence env, model, bypass acceptance and any
 *     provider env keys the agent-auth push installed pinned;
 *   - codex config.toml: the host's `[projects.*]` trust tables and
 *     `[features] hooks` survive, the rest is the laptop's;
 *   - ~/.gitconfig: only the `# >>> codecast mirror` block is ours.
 *
 * Everything runs under ~/.codecast/mirror.lock (shared with the other host
 * writers of these files), and every merge re-reads its host file inside it.
 * A per-file stamp (~/.codecast/mirror.json) records what was written so a
 * host-side edit of a verbatim file is detected and kept — for as long as
 * the laptop copy stays the same — rather than silently reverted, and only
 * verbatim files the mirror itself put there are pruned. Merged kinds are
 * co-owned with the host's own writers (the daemon's config_write, the
 * hook installers), so a host edit to them is not detected: the next push
 * re-merges laptop over host.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { FORCE_PERSISTENCE_VAR, ensureClaudeSettingsPersistence } from "../../agentEnv.js";
import { isCodecastHookCommand, isCodecastOwnedHomePath } from "../../codecastOwned.js";
import { installAllStableHooks } from "../../stableContext.js";
import { assertSafePath, sha256, type ParsedBundle, type ParsedFile } from "./bundle.js";
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
  /** sha256 of the bytes the MIRROR last put on disk (after apply + refresh). */
  written: string;
  mode: "0600" | "0700";
  /** Absent in stamps older than the kind-aware prune: treated as verbatim. */
  kind?: MirrorKind;
  /** The host changed this file since the mirror wrote it; kept until the laptop copy changes. */
  host_edited?: true;
  source?: string;
  removed?: true;
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
}

export const MIRROR_STAMP_REL = ".codecast/mirror.json";
export const MIRROR_LOCK_REL = ".codecast/mirror.lock";
export const MIRRORED_ENV_MANIFEST_REL = ".codecast/mirrored-claude-env.json";
export const GITCONFIG_BLOCK_START = "# >>> codecast mirror";
export const GITCONFIG_BLOCK_END = "# <<< codecast mirror";

/** Kinds written as the laptop sent them; host edits to these are detected and kept. */
const VERBATIM_KINDS: readonly MirrorKind[] = ["verbatim", "json-remap", "toml-remap", "gemini-settings", "opencode-json", "gitignore"];

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
export async function withMirrorLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const file = path.join(home, MIRROR_LOCK_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
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

/** Tables the laptop never ships and the host therefore owns: trust and MCP. */
const HOST_OWNED_CODEX_TABLES = ["projects", "mcp_servers"];

/**
 * codex config.toml: the laptop's tables minus `[projects.*]`/`[mcp_servers.*]`,
 * the host's `[features] hooks = …` line kept, the host's `[projects.*]`
 * (trust, another feature's) and `[mcp_servers.*]` (added on the box; the
 * laptop's are never shipped, so nothing else could restore them) tables
 * appended verbatim.
 */
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
  let text = joinTomlTables(out).replace(/\n{3,}/g, "\n\n");
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

function checkDestination(home: string, rel: string): void {
  assertSafePath(rel);
  let dir = home;
  for (const part of rel.split("/")) {
    dir = path.join(dir, part);
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw new Error("destination is a symlink");
  }
}

export function verifyMirrorStamp(home: string): MirrorStamp | null {
  const stamp = readStamp(home);
  if (!stamp) return null;
  let complete = stamp.complete === true;
  for (const [rel, info] of Object.entries(stamp.files)) {
    try {
      checkDestination(home, rel);
      const bytes = readIfRegular(path.join(home, rel));
      if (info.removed) {
        if (fs.existsSync(path.join(home, rel))) complete = false;
        continue;
      }
      const mode = fs.statSync(path.join(home, rel)).mode & 0o777;
      if (info.host_edited || !bytes || sha256(bytes) !== info.written || mode !== Number.parseInt(info.mode, 8)) complete = false;
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

export function finalBytes(file: ParsedFile, current: Buffer | null, home: string, pinnedEnvKeys: readonly string[], previous?: StampFile, conflict: () => void = () => {}): Buffer {
  const text = file.bytes.toString("utf-8");
  const cur = current ? current.toString("utf-8") : null;
  // The host's own installers (installHookScript, installStableHook*) write
  // settings.json with 4-space and hooks.json with 2-space indent and no
  // trailing newline; matching them is what makes a second apply a no-op.
  const json = (v: unknown, indent: number) => Buffer.from(JSON.stringify(v, null, indent));
  const parse = (s: string | null) => { if (s === null) return null; try { return JSON.parse(s); } catch { return null; } };
  switch (file.kind) {
    case "claude-md":
    case "agents-md":
      return Buffer.from(composeInstructionFile(text, cur));
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
    case "codex-toml":
      return Buffer.from(mergeCodexToml(text, cur));
    case "gitconfig":
      return Buffer.from(mergeGitconfig(text, cur));
    default:
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

  const pinned = opts.pinnedEnvKeys ?? readMirroredEnvKeys(home);
  const stampFiles: Record<string, StampFile> = {};
  const manifest = new Set(bundle.files.map((f) => f.path));

  for (const file of bundle.files) {
    if (isCodecastOwnedHomePath(file.path)) { result.errors.push({ path: file.path, error: "codecast-owned path" }); continue; }
    const abs = path.join(home, file.path);
    try {
      const current = readIfRegular(abs);
      const before = prev?.files[file.path];
      if (before && current && VERBATIM_KINDS.includes(file.kind)) {
        // Host-edited: the bytes differ from what the mirror last wrote while
        // the laptop still sends what it sent then. `written` stays the
        // mirror's own sha, so the edit is kept on every later apply until
        // the laptop copy changes (or the host restores the mirrored bytes).
        const hostSha = sha256(current);
        if (hostSha !== before.written && file.sha256 === before.sha) {
          result.host_edited.push(file.path);
          stampFiles[file.path] = { sha: before.sha, written: before.written, mode: before.mode, kind: file.kind, host_edited: true };
          continue;
        }
      }
      const bytes = finalBytes(file, current, home, pinned);
      const sameBytes = current !== null && current.equals(bytes);
      let sameMode = true;
      if (current !== null) {
        const st = fs.statSync(abs);
        sameMode = (st.mode & 0o777) === (file.mode === "0700" ? 0o700 : 0o600);
      }
      if (sameBytes && sameMode) result.unchanged++;
      else {
        writeMirroredFile(home, file.path, bytes, file.mode);
        result.applied.push(file.path);
      }
      stampFiles[file.path] = { sha: file.sha256, written: sha256(bytes), mode: file.mode, kind: file.kind };
    } catch (err) {
      result.errors.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Prune: only VERBATIM files a previous mirror put under a managed root and
  // the new manifest lacks, still holding the mirror's bytes. Merged kinds
  // are co-owned (codex trust tables, settings pins, the host's own snippet
  // sections) and simply stop being tracked; the gitconfig kind loses just
  // its marker block. A stamped file the host edited is its own now: kept,
  // reported once, untracked.
  if (prev) {
    const roots = bundle.header.managed_roots.length ? bundle.header.managed_roots : prev.managed_roots;
    for (const [rel, info] of Object.entries(prev.files)) {
      if (manifest.has(rel) || isCodecastOwnedHomePath(rel)) continue;
      const kind = info.kind ?? "verbatim";
      const abs = path.join(home, rel);
      const current = readIfRegular(abs);
      if (current === null) continue;
      if (kind === "gitconfig") {
        try {
          const stripped = stripGitconfigBlock(current.toString("utf-8"));
          if (stripped !== current.toString("utf-8")) {
            if (stripped.trim()) writeMirroredFile(home, rel, Buffer.from(stripped), info.mode); else fs.unlinkSync(abs);
            result.pruned.push(rel);
          }
        } catch (err) {
          result.errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      if (!VERBATIM_KINDS.includes(kind)) continue;
      const root = roots.find((r) => rel === r || rel.startsWith(`${r}/`));
      if (!root) continue;
      if (info.host_edited || sha256(current) !== info.written) { result.host_edited.push(rel); continue; }
      try {
        fs.unlinkSync(abs);
        result.pruned.push(rel);
        removeEmptyParents(home, rel, root);
      } catch (err) {
        result.errors.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  (opts.refresh ?? runHostRefresh)(home);

  // The post-refresh bytes are what the next apply compares against — except
  // for a host-edited file, whose `written` must stay the mirror's own sha.
  for (const [rel, info] of Object.entries(stampFiles)) {
    if (info.host_edited) continue;
    const current = readIfRegular(path.join(home, rel));
    if (current) info.written = sha256(current);
  }
  const stamp: MirrorStamp = {
    version: 1,
    hash: bundle.hash,
    source_device_id: src.device_id,
    source_user_id: src.user_id,
    applied_at: now().toISOString(),
    files: stampFiles,
    managed_roots: bundle.header.managed_roots,
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
    spawnSync(process.execPath, [entry, "snippets-refresh"], {
      env: { ...process.env, HOME: home }, stdio: "ignore", timeout: 120_000,
    });
  }
  let stableMode: string | undefined;
  try { stableMode = JSON.parse(fs.readFileSync(path.join(home, ".codecast", "config.json"), "utf-8"))?.stable_mode; } catch { /* no config */ }
  if (stableMode === "solo" || stableMode === "team") {
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      installAllStableHooks();
    } catch { /* optional enhancement */ } finally {
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    }
  }
  try { ensureClaudeSettingsPersistence(home); } catch { /* optional */ }
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
