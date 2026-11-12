/**
 * Carrying a session's folder from another of the owner's machines.
 *
 * A session moved to this machine resumes in the folder it recorded. When that
 * folder exists only on the machine it came from and has no git remote to
 * clone, every resume used to refuse with "no checkout here", and the only way
 * forward was to copy the folder by hand. Now the destination asks the owner's
 * other online machines for it: the one that holds the folder packs it
 * (export_folder), puts the archive in Convex storage, and the destination
 * unpacks it at the same place and resumes there.
 *
 * What travels. In a git checkout or a folder inside one, exactly what git
 * would carry from it (plus .git itself at the checkout's root): tracked and
 * untracked files minus .gitignore'd ones, so a gitignored .env stays behind
 * the same way it does for wipSnapshot. Outside git, every file except
 * regenerable caches (node_modules, virtualenvs, build caches). Files that look
 * like keys or credentials never travel, tracked or not. A folder past MAX_FOLDER_BYTES is refused before anything is
 * packed: storage is a relay for a working folder, not a backup channel.
 */

import { execFile, lastErrorLine, spawn } from "./proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { localTailnetAsync, selfTailnet, type TailnetStatus } from "./cloud/tailnet.js";
import { firewallBlocksIncoming, grantBindAddress, verifyOwnerPeer } from "./peer/identity.js";
import { newGrantSecret, openGrant, type GrantOutcome } from "./peer/grant.js";
import { pullGrantInto } from "./peer/pull.js";
import { sanitizeExtractedTree } from "./folderSanitize.js";

export { sanitizeExtractedTree };

const execFileAsync = promisify(execFile);

export const MAX_FOLDER_BYTES = 300 * 1024 * 1024;
export const MAX_DIRECT_BYTES = 2 * 1024 * 1024 * 1024;
const UNPACK_SLACK = 512 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = MAX_DIRECT_BYTES + UNPACK_SLACK;
export const FOLDER_BUNDLE_MEDIA_TYPE = "application/gzip";
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache", ".pytest_cache", ".mypy_cache",
]);

const SECRET_NAMES = /^(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|id_[a-z0-9_]+(\.pub)?|credentials.*|.*\.(pem|key|p12|pfx|keystore|jks))$/i;

/** Files that look like keys or credentials never travel, whatever the folder's .gitignore says. */
export function isSecretFile(name: string): boolean {
  return SECRET_NAMES.test(name);
}

/**
 * Where a session folder may be carried from or to: inside home, not in a
 * dot-folder at the top of home (~/.ssh, ~/.aws, ~/.config...), not under
 * ~/Library, and never home itself. Checked on the path as named and on where
 * it really leads, so a symlink into a private folder is refused too. Null
 * when allowed, else the reason.
 */
export function refusedFolder(dir: string, home: string): string | null {
  if (!home) return `${dir} is a home or root folder`;
  const named = placeRefusal(path.resolve(dir), path.resolve(home));
  const real = placeRefusal(realPathOf(dir), realPathOf(home));
  const why = real ?? (named === "outside" ? null : named);
  if (why === "home") return `${dir} is a home or root folder`;
  if (why === "outside") return `${dir} is outside your home folder`;
  if (why === "private") return `${dir} is a private folder`;
  return null;
}

function placeRefusal(abs: string, h: string): "home" | "outside" | "private" | null {
  if (abs === h || abs === "/") return "home";
  const rel = path.relative(h, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "outside";
  const top = rel.split(path.sep)[0];
  return top.startsWith(".") || top === "Library" ? "private" : null;
}

/** Where `p` really leads: the deepest existing ancestor resolved through its
 *  symlinks, with the parts that do not exist yet appended. */
function realPathOf(p: string): string {
  const rest: string[] = [];
  for (let cur = path.resolve(p); ; cur = path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      if (path.dirname(cur) === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
    }
  }
}

/** The recorded path as it would sit on this machine: another user's home
 *  prefix (/Users/m1, /home/m1) becomes this one's. */
export function localFolderFor(recorded: string, home: string): string {
  const m = recorded.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (!m || !home) return recorded;
  return m[1] ? path.join(home, m[1]) : home;
}

export type FolderPlan =
  | { ok: true; dir: string; entries: string[]; bytes: number; files: number }
  | { ok: false; reason: string; missing?: boolean };

async function gitOut(dir: string, args: string[]): Promise<string> {
  const out: unknown = await execFileAsync("git", ["-C", dir, ...args], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  return typeof out === "string" ? out : String((out as { stdout: string }).stdout);
}

/** What git would carry from `dir` when it sits in a work tree (the whole
 *  checkout, or the subtree a session ran in), relative to `dir`; null outside
 *  git or when an enclosing repo ignores `dir`. */
async function gitFiles(dir: string): Promise<{ root: boolean; files: string[] } | null> {
  try {
    const top = fs.realpathSync((await gitOut(dir, ["rev-parse", "--show-toplevel"])).trim());
    const real = fs.realpathSync(dir);
    const root = top === real;
    if (!root && (await gitOut(top, ["check-ignore", "-q", "--", path.relative(top, real) + "/"]).then(() => true, () => false))) return null;
    const split = (out: string) => out.split("\0").filter(Boolean);
    const tracked = split(await gitOut(dir, ["ls-files", "-c", "-z"]));
    const untracked = split(await gitOut(dir, ["ls-files", "-o", "--exclude-standard", "-z"]))
      .filter((rel) => !rel.split("/").some((part) => SKIPPED_DIRS.has(part)));
    const files = [...new Set([...tracked, ...untracked])].filter((rel) => !isSecretFile(path.basename(rel)));
    return { root, files };
  } catch {
    return null;
  }
}

async function walk(root: string, rel: string, out: { entries: string[]; bytes: number }, cap: number): Promise<boolean> {
  const here = path.join(root, rel);
  let items: fs.Dirent[];
  try {
    items = await fs.promises.readdir(here, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const item of items) {
    const childRel = rel ? path.join(rel, item.name) : item.name;
    if (item.isDirectory()) {
      if (SKIPPED_DIRS.has(item.name)) continue;
      if (!(await walk(root, childRel, out, cap))) return false;
      continue;
    }
    if (isSecretFile(item.name) || item.name === ".DS_Store") continue;
    if (!item.isFile() && !item.isSymbolicLink()) continue;
    const st = await fs.promises.lstat(path.join(root, childRel)).catch(() => null);
    if (!st) continue;
    out.bytes += st.size;
    out.entries.push(childRel);
    if (out.bytes > cap) return false;
  }
  return true;
}

async function dirBytes(dir: string, cap: number): Promise<number> {
  const out = { entries: [] as string[], bytes: 0 };
  await walk(dir, "", out, cap);
  return out.bytes;
}

/** Decide what to pack, or why not. Never reads past the cap. */
export async function planFolderExport(dir: string, cap = MAX_FOLDER_BYTES): Promise<FolderPlan> {
  const st = await fs.promises.stat(dir).catch(() => null);
  if (!st?.isDirectory()) return { ok: false, missing: true, reason: `${dir} is not on this machine` };
  const git = await gitFiles(dir);
  const tooBig = { ok: false as const, reason: `${dir} is over ${Math.round(cap / (1024 * 1024))} MB, too large to carry` };
  if (git) {
    let bytes = git.root ? await dirBytes(path.join(dir, ".git"), cap) : 0;
    const entries: string[] = git.root ? [".git"] : [];
    for (const rel of git.files) {
      const fst = await fs.promises.lstat(path.join(dir, rel)).catch(() => null);
      if (!fst || fst.isDirectory()) continue;
      bytes += fst.size;
      entries.push(rel);
      if (bytes > cap) return tooBig;
    }
    if (bytes > cap) return tooBig;
    return { ok: true, dir, entries, bytes, files: git.root ? entries.length - 1 : entries.length };
  }
  const out = { entries: [] as string[], bytes: 0 };
  if (!(await walk(dir, "", out, cap))) return tooBig;
  return { ok: true, dir, entries: out.entries, bytes: out.bytes, files: out.entries.length };
}

export type PlannedFolder = Extract<FolderPlan, { ok: true }>;

/** Stream a plan as a gzipped tar. A tar that fails errors the stream rather than ending it. */
export function packFolderStream(plan: PlannedFolder): { stream: NodeJS.ReadableStream; kill: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-folder-"));
  const list = path.join(tmp, "files");
  fs.writeFileSync(list, plan.entries.join("\0") + "\0");
  const out = new PassThrough();
  const child = spawn("tar", ["-czf", "-", "-C", plan.dir, "--null", "-T", list], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  let stderr = "";
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d).slice(-4000); });
  let exit: { code: number | null; signal: string | null } | undefined;
  let drained = false;
  const settle = () => {
    if (!exit || out.writableEnded || out.destroyed) return;
    if (exit.code !== 0) return void out.destroy(new Error(`tar: ${lastErrorLine(stderr) || (exit.signal ? `killed by ${exit.signal}` : `exit ${exit.code}`)}`));
    if (drained) out.end();
  };
  // "close" waits on every stdio stream; under load bun has left one open, so
  // the exit status and the end of stdout decide instead.
  const exited = (code: number | null, signal: string | null) => {
    if (exit) return;
    exit = { code, signal };
    cleanup();
    settle();
  };
  child.stdout!.on("end", () => { drained = true; settle(); });
  child.stdout!.pipe(out, { end: false });
  child.on("error", (e: Error) => { cleanup(); out.destroy(e); });
  child.on("exit", exited);
  child.on("close", exited);
  return { stream: out, kill: () => { child.kill("SIGKILL"); } };
}

/** Pack a plan into a gzipped tar held in memory. */
export async function packFolder(plan: PlannedFolder): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of packFolderStream(plan).stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

function extractInto(body: NodeJS.ReadableStream, dir: string, maxBytes: number, maxUnpacked: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-xf", "-", "-C", dir, "--no-same-owner", "--no-same-permissions"], { stdio: ["pipe", "ignore", "pipe"] });
    const gunzip = createGunzip();
    let stderr = "";
    let failed: Error | null = null;
    let bytes = 0;
    let unpacked = 0;
    let tarCode: number | null | undefined;
    let gunzipEnded = false;
    const settle = () => {
      if (failed) return reject(failed);
      if (tarCode === undefined || !gunzipEnded) return;
      if (tarCode === 0) resolve();
      else reject(new Error(`tar: ${lastErrorLine(stderr) || `exit ${tarCode}`}`));
    };
    const stop = (e: Error) => {
      if (failed) return;
      failed = e;
      gunzip.destroy();
      tar.kill("SIGKILL");
      if (tarCode !== undefined) settle();
    };
    tar.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d).slice(-4000); });
    tar.stdin!.on("error", () => {});
    tar.on("error", stop);
    const readable = body as NodeJS.ReadableStream & { destroyed?: boolean; readableEnded?: boolean };
    let bodyEnded = !!readable.readableEnded;
    body.on("end", () => { bodyEnded = true; });
    body.on("error", (e: Error) => stop(e));
    body.on("close", () => { if (!bodyEnded) stop(new Error("archive stream closed before its end")); });
    if (readable.destroyed && !bodyEnded) stop(new Error("archive stream closed before its end"));
    body.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(new Error(`archive is over ${maxBytes} bytes`));
    });
    gunzip.on("error", (e: Error) => stop(new Error(`gzip: ${e.message}`)));
    gunzip.on("data", (chunk: Buffer) => {
      unpacked += chunk.length;
      if (unpacked > maxUnpacked) stop(new Error(`archive unpacks to over ${maxUnpacked} bytes`));
    });
    gunzip.on("end", () => { gunzipEnded = true; settle(); });
    body.pipe(gunzip).pipe(tar.stdin!);
    const exited = (code: number | null) => {
      if (tarCode !== undefined) return;
      tarCode = code;
      if (!gunzipEnded) gunzip.resume();
      settle();
    };
    tar.on("exit", exited);
    tar.on("close", exited);
  });
}

/** Unpack a gzipped tar stream into `dest`, which must not exist yet. Extracts
 *  beside it, sanitizes, and renames into place, so a failed unpack never
 *  leaves a half folder that the next resume would take for the real one. */
export async function unpackFolderStream(body: NodeJS.ReadableStream, dest: string, opts: { maxBytes?: number; maxUnpackedBytes?: number } = {}): Promise<void> {
  const parent = path.dirname(dest);
  // Synchronous on purpose: extractInto must be listening before this turn
  // ends, or a body the puller destroys meanwhile is never seen to fail.
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(dest)}.codecast-sync-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(staging);
  try {
    await extractInto(body, staging, opts.maxBytes ?? MAX_DIRECT_BYTES, opts.maxUnpackedBytes ?? MAX_UNPACKED_BYTES);
    await sanitizeExtractedTree(staging);
    if (fs.existsSync(dest)) return;
    await fs.promises.rename(staging, dest);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export function unpackFolder(bytes: Uint8Array, dest: string): Promise<void> {
  return unpackFolderStream(Readable.from([Buffer.from(bytes)]), dest, { maxUnpackedBytes: MAX_FOLDER_BYTES + UNPACK_SLACK });
}

export interface DirectEndpoint { ip: string; name: string; port: number }

export type ExportFolderResult =
  | { ok: true; storage_id: string; bytes: number; files: number; path: string; direct_skipped?: string }
  | { ok: true; direct: DirectEndpoint; bytes: number; files: number; path: string }
  | { ok: false; missing?: boolean; reason: string; direct_skipped?: string };

export interface ExportFolderArgs {
  path?: unknown;
  relay_only?: unknown;
  direct?: unknown;
}

export interface ExportFolderDeps {
  home: string;
  upload: (bytes: Uint8Array) => Promise<string | null>;
  log?: (m: string) => void;
  tailnetStatus?: () => Promise<TailnetStatus | null>;
  firewallBlocks?: () => Promise<boolean>;
  onGrantDone?: (outcome: GrantOutcome) => void;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function directRequest(raw: unknown): { requester: { ip: string; name: string }; token_hash: string } | null {
  const d = raw as { requester?: { ip?: unknown; name?: unknown }; token_hash?: unknown } | null;
  const ip = d?.requester?.ip, name = d?.requester?.name, hash = d?.token_hash;
  if (typeof ip !== "string" || !IPV4.test(ip) || typeof name !== "string" || !name) return null;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  return { requester: { ip, name }, token_hash: hash };
}

/** Open a grant for `plan` when every direct condition holds; else the reason it was skipped. */
async function grantDirect(
  plan: PlannedFolder,
  direct: NonNullable<ReturnType<typeof directRequest>>,
  deps: ExportFolderDeps,
): Promise<{ ok: true; endpoint: DirectEndpoint } | { ok: false; reason: string }> {
  const status = await (deps.tailnetStatus ?? localTailnetAsync)();
  const peer = verifyOwnerPeer(status, direct.requester);
  if (!peer.ok) return peer;
  const bind = grantBindAddress(status);
  if (!bind.ok) return bind;
  if (await (deps.firewallBlocks ?? firewallBlocksIncoming)()) return { ok: false, reason: "firewall: incoming connections are blocked" };
  if (plan.bytes > MAX_DIRECT_BYTES) return { ok: false, reason: "too_large: over the direct cap" };
  try {
    const grant = await openGrant({ bindIp: bind.ip, allowFrom: direct.requester.ip, tokenHash: direct.token_hash, serve: () => packFolderStream(plan) });
    void grant.done.then((o) => deps.onGrantDone?.(o));
    return { ok: true, endpoint: { ip: bind.ip, name: selfTailnet(status)!.name, port: grant.port } };
  } catch (e) {
    return { ok: false, reason: `grant_failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The source side of export_folder: find the folder here, then serve it
 *  directly when the requester offered a direct link and it can be granted,
 *  else pack it and upload it. */
export async function exportFolder(args: ExportFolderArgs, deps: ExportFolderDeps): Promise<ExportFolderResult> {
  const recorded = typeof args.path === "string" && path.isAbsolute(args.path) ? args.path : null;
  if (!recorded) return { ok: false, reason: "export_folder: missing or relative path" };
  const dir = [recorded, localFolderFor(recorded, deps.home)].find((p) => fs.existsSync(p)) ?? recorded;
  const refused = refusedFolder(dir, deps.home);
  if (refused) return { ok: false, reason: `${refused}; refusing to carry it` };
  const plan = await planFolderExport(dir, wantsDirect(args) ? MAX_DIRECT_BYTES : MAX_FOLDER_BYTES);
  if (!plan.ok) return { ok: false, missing: plan.missing, reason: plan.reason };
  return servePlan(plan, args, deps);
}

/** Whether the request offers a direct link this source may consider. */
export function wantsDirect(args: ExportFolderArgs): boolean {
  return args.relay_only !== true && directRequest(args.direct) !== null;
}

/** Serve a planned export: directly when the requester offered a link and it
 *  can be granted, else packed and uploaded within the relay cap. */
export async function servePlan(plan: PlannedFolder, args: ExportFolderArgs, deps: ExportFolderDeps): Promise<ExportFolderResult> {
  const dir = plan.dir;
  const direct = args.relay_only === true ? null : directRequest(args.direct);
  let skipped: string | undefined;
  if (direct) {
    const granted = await grantDirect(plan, direct, deps);
    if (granted.ok) {
      deps.log?.(`[FOLDER] granted ${dir} directly to ${direct.requester.name}: ${plan.files} files, ${plan.bytes} bytes`);
      return { ok: true, direct: granted.endpoint, bytes: plan.bytes, files: plan.files, path: dir };
    }
    skipped = granted.reason;
    deps.log?.(`[FOLDER] direct link to ${direct.requester.name} skipped: ${skipped}`);
  }
  if (plan.bytes > MAX_FOLDER_BYTES) {
    return { ok: false, reason: `${dir} is over ${Math.round(MAX_FOLDER_BYTES / (1024 * 1024))} MB, too large to carry`, ...(skipped ? { direct_skipped: skipped } : {}) };
  }
  const bytes = await packFolder(plan);
  deps.log?.(`[FOLDER] packed ${dir}: ${plan.files} files, ${plan.bytes} bytes -> ${bytes.length} bytes`);
  const storageId = await deps.upload(bytes);
  if (!storageId) return { ok: false, reason: `upload of ${dir} failed`, ...(skipped ? { direct_skipped: skipped } : {}) };
  return { ok: true, storage_id: storageId, bytes: bytes.length, files: plan.files, path: dir, ...(skipped ? { direct_skipped: skipped } : {}) };
}

export interface PeerRequest {
  command_ids: string[];
  labels: Record<string, string>;
}

export interface PeerRequestOpts {
  tailnet?: { ip: string; name: string };
  token_hash?: string;
  relay_only?: boolean;
  only_device_id?: string;
}

export interface PeerOutcome {
  command_id: string;
  executed_at: number | null;
  result: string | null;
  error: string | null;
  label: string | null;
  device_id?: string | null;
}

export type TransferMode = "direct" | "relay";

export interface PeerAttempt { device: string; device_id?: string; mode: TransferMode; ok: boolean; reason?: string; bytes?: number }

export interface PeerProgress {
  phase: "asking" | "receiving" | "unpacking";
  from?: string;
  mode?: TransferMode;
  bytes?: number;
  total?: number;
}

export type ExportAnswer = Extract<ExportFolderResult, { ok: true }>;

export interface SyncFromPeerDeps {
  /** Unpack an answer's archive; the default unpacks the folder at `dest`. */
  receive?: (body: NodeJS.ReadableStream, answer: ExportAnswer, limits: { maxBytes: number; maxUnpackedBytes?: number }) => Promise<void>;
  /** Why an answer is unusable before anything is pulled; a refusal is that peer's answer, not a failed link. */
  validate?: (answer: ExportAnswer) => string | null;
  request: (opts?: PeerRequestOpts) => Promise<PeerRequest>;
  outcomes: (ids: string[]) => Promise<PeerOutcome[]>;
  download: (storageId: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
  discard: (commandId: string) => Promise<void>;
  /** This machine's place on the tailnet when it can take a direct link; null offers none. */
  direct?: () => Promise<{ self: { ip: string; name: string } } | null>;
  tailnetStatus?: () => Promise<TailnetStatus | null>;
  onAttempt?: (a: PeerAttempt) => void;
  onProgress?: (p: PeerProgress) => void;
  /** True once the person cancelled: checked each poll, and it aborts a pull or download in flight. */
  cancelled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}

export type SyncFromPeerResult =
  | { ok: true; path: string; from: string; files: number; mode: TransferMode }
  | { ok: false; reason: string };

export const PEER_WAIT_MS = 120_000;
const POLL_MS = 1_500;
const PROGRESS_MS = 5_000;
const CANCEL_CHECK_MS = 250;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CANCELLED = { ok: false as const, reason: "cancelled" };

/** A new phase goes out at once; repeats of one phase at most every `everyMs`
 *  (the reporter's heartbeat keeps the row fresh in between). */
export function progressThrottle(send: (p: PeerProgress) => void, now: () => number = Date.now, everyMs = PROGRESS_MS) {
  let last: { phase: string; at: number } | null = null;
  return (p: PeerProgress) => {
    const t = now();
    if (last && last.phase === p.phase && t - last.at < everyMs) return;
    last = { phase: p.phase, at: t };
    send(p);
  };
}

/** The destination side: ask every other online machine, take the first that
 *  has the folder (directly when it granted a link, else through the relay),
 *  unpack it at `dest`. */
export async function syncFolderFromPeer(dest: string, deps: SyncFromPeerDeps, waitMs = PEER_WAIT_MS): Promise<SyncFromPeerResult> {
  const ids: string[] = [];
  try {
    return await askPeers(dest, deps, waitMs, ids);
  } finally {
    for (const id of ids) await deps.discard(id).catch(() => {});
  }
}

async function askPeers(dest: string, deps: SyncFromPeerDeps, waitMs: number, ids: string[]): Promise<SyncFromPeerResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const progress = progressThrottle((p) => deps.onProgress?.(p));
  const stop = () => deps.cancelled?.() === true;
  progress({ phase: "asking" });
  if (stop()) return CANCELLED;
  const offer = await deps.direct?.().catch(() => null) ?? null;
  let secret = offer ? newGrantSecret() : null;
  const labels: Record<string, string> = {};
  const ask = async (opts: PeerRequestOpts) => {
    const asked = await deps.request(opts);
    for (const id of asked.command_ids) if (!ids.includes(id)) ids.push(id);
    Object.assign(labels, asked.labels);
  };
  const askPlain = (opts: PeerRequestOpts, e: unknown) => {
    deps.log?.(`[FOLDER] request with ${Object.keys(opts).join(", ")} refused (${message(e)}); asking without them`);
    return ask({});
  };
  try {
    if (offer && secret) {
      const opts = { tailnet: offer.self, token_hash: secret.hash };
      await ask(opts).catch((e) => { secret = null; return askPlain(opts, e); });
    } else await ask({});
  } catch (e) {
    return { ok: false, reason: message(e) };
  }
  if (ids.length === 0) return { ok: false, reason: "none of your other machines is online to send it" };
  let deadline = now() + waitMs;
  const reasons = new Map<string, string>();
  while (now() < deadline) {
    if (stop()) return CANCELLED;
    const rows = await deps.outcomes([...ids]).catch(() => [] as PeerOutcome[]);
    for (const row of rows) {
      if (!row.executed_at || reasons.has(row.command_id)) continue;
      const label = row.label ?? labels[row.command_id] ?? "another machine";
      const deviceId = row.device_id ?? undefined;
      let parsed: ExportFolderResult | null = null;
      try { parsed = row.result ? JSON.parse(row.result) : null; } catch {}
      const refused = parsed?.ok ? deps.validate?.(parsed) : null;
      if (refused) {
        reasons.set(row.command_id, `${label}: ${refused}`);
        continue;
      }
      const skipped = parsed && "direct_skipped" in parsed ? parsed.direct_skipped : undefined;
      if (secret && skipped && !skipped.startsWith("too_large")) {
        deps.onAttempt?.({ device: label, device_id: deviceId, mode: "direct", ok: false, reason: skipped });
      }
      if (parsed?.ok && "direct" in parsed && secret) {
        const started = now();
        const got = await pullDirect(dest, parsed, secret.secret, label, deviceId, deps, progress);
        deadline += now() - started;
        if (got.ok) return { ok: true, path: dest, from: label, files: parsed.files, mode: "direct" };
        if (got.reason === CANCELLED.reason) return CANCELLED;
        reasons.set(row.command_id, `${label}: direct link failed (${got.reason})`);
        if (row.device_id) {
          try {
            const opts = { relay_only: true, only_device_id: row.device_id };
            await ask(opts).catch((e) => askPlain(opts, e));
          } catch (e) {
            reasons.set(row.command_id, `${label}: direct link failed (${got.reason}); relay: ${message(e)}`);
          }
        }
        continue;
      }
      if (parsed?.ok && "storage_id" in parsed) {
        try {
          progress({ phase: "receiving", from: label, mode: "relay", total: parsed.bytes });
          const watch = watchCancel(deps);
          const bytes = await deps.download(parsed.storage_id, watch.signal).catch((e) => {
            if (watch.signal.aborted) return null;
            throw e;
          }).finally(watch.stop);
          if (watch.signal.aborted) return CANCELLED;
          if (!bytes) {
            reasons.set(row.command_id, `${label}: download failed`);
            deps.onAttempt?.({ device: label, device_id: deviceId, mode: "relay", ok: false, reason: "download failed" });
            continue;
          }
          if (stop()) return CANCELLED;
          progress({ phase: "unpacking", from: label, mode: "relay", bytes: bytes.length, total: parsed.bytes });
          await receiveWith(dest, deps)(Readable.from([Buffer.from(bytes)]), parsed, { maxBytes: MAX_DIRECT_BYTES, maxUnpackedBytes: MAX_FOLDER_BYTES + UNPACK_SLACK });
          deps.onAttempt?.({ device: label, device_id: deviceId, mode: "relay", ok: true, bytes: bytes.length });
          deps.log?.(`[FOLDER] synced ${dest} from ${label} through the relay: ${parsed.files} files`);
          return { ok: true, path: dest, from: label, files: parsed.files, mode: "relay" };
        } catch (e) {
          reasons.set(row.command_id, `${label}: ${message(e)}`);
          deps.onAttempt?.({ device: label, device_id: deviceId, mode: "relay", ok: false, reason: message(e) });
        }
        continue;
      }
      const why = parsed && !parsed.ok ? parsed : null;
      reasons.set(row.command_id, why?.missing ? "" : `${label}: ${why?.reason ?? row.error ?? "no answer"}`);
    }
    if (reasons.size === ids.length) break;
    progress({ phase: "asking" });
    await sleep(POLL_MS);
  }
  const said = [...reasons.values()].filter(Boolean);
  if (said.length) return { ok: false, reason: said.join("; ") };
  if (reasons.size === ids.length) return { ok: false, reason: "none of your other machines has it" };
  return { ok: false, reason: `no answer from ${[...new Set(Object.values(labels))].join(", ")} in ${Math.round(waitMs / 1000)}s` };
}

const receiveWith = (dest: string, deps: SyncFromPeerDeps) =>
  deps.receive ?? ((body: NodeJS.ReadableStream, _a: ExportAnswer, limits: { maxBytes: number; maxUnpackedBytes?: number }) => unpackFolderStream(body, dest, limits));

async function pullDirect(
  dest: string,
  answer: Extract<ExportAnswer, { direct: DirectEndpoint }>,
  secret: string,
  label: string,
  deviceId: string | undefined,
  deps: SyncFromPeerDeps,
  progress: (p: PeerProgress) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fail = (reason: string) => {
    deps.onAttempt?.({ device: label, device_id: deviceId, mode: "direct", ok: false, reason });
    deps.log?.(`[FOLDER] direct link from ${label} failed: ${reason}`);
    return { ok: false as const, reason };
  };
  const source = verifyOwnerPeer(await (deps.tailnetStatus ?? localTailnetAsync)().catch(() => null), answer.direct);
  if (!source.ok) return fail(source.reason);
  const maxBytes = MAX_DIRECT_BYTES + 64 * 1024 * 1024;
  const watch = watchCancel(deps);
  try {
    progress({ phase: "receiving", from: label, mode: "direct", bytes: 0, total: answer.bytes });
    const { bytes } = await pullGrantInto({
      ip: answer.direct.ip,
      port: answer.direct.port,
      secret,
      maxBytes,
      signal: watch.signal,
      onBytes: (n) => {
        progress({ phase: "receiving", from: label, mode: "direct", bytes: n, total: answer.bytes });
        watch.check();
      },
      sink: (body) => {
        body.on("end", () => progress({ phase: "unpacking", from: label, mode: "direct", total: answer.bytes }));
        return receiveWith(dest, deps)(body, answer, { maxBytes });
      },
    });
    deps.onAttempt?.({ device: label, device_id: deviceId, mode: "direct", ok: true, bytes });
    deps.log?.(`[FOLDER] synced ${dest} from ${label} directly: ${bytes} bytes`);
    return { ok: true };
  } catch (e) {
    return watch.signal.aborted ? CANCELLED : fail(message(e));
  } finally {
    watch.stop();
  }
}

function watchCancel(deps: SyncFromPeerDeps) {
  const abort = new AbortController();
  const check = () => { if (deps.cancelled?.()) abort.abort(); };
  const timer = setInterval(check, CANCEL_CHECK_MS);
  return { signal: abort.signal, check, stop: () => clearInterval(timer) };
}

export type PeerTransferReport = Omit<PeerProgress, "phase"> & { phase: PeerProgress["phase"] | "done" | "failed"; reason?: string };

const TRANSFER_HEARTBEAT_MS = 5_000;

/** Sends a transfer's progress one report at a time, keeping only the newest
 *  while one is in flight, and repeats the last one while nothing new comes
 *  (a relay download, a long unpack) so the row stays fresh and a cancel is
 *  read back. `cancelled` turns true once a report's answer says so. */
export function peerTransferReporter(
  send: (r: PeerTransferReport) => Promise<{ cancel: boolean } | null | undefined>,
  opts: { heartbeatMs?: number; log?: (m: string) => void } = {},
) {
  let cancelled = false;
  let last: PeerTransferReport | null = null;
  let next: PeerTransferReport | null = null;
  let busy: Promise<void> | null = null;
  let finished = false;
  const pump = () => {
    busy ??= (async () => {
      for (let r = next; r; r = next) {
        next = null;
        try {
          if ((await send(r))?.cancel) cancelled = true;
        } catch (e) {
          opts.log?.(`[FOLDER] transfer progress not reported: ${message(e)}`);
        }
      }
      busy = null;
    })();
  };
  const heartbeat = setInterval(() => {
    if (!busy && last) { next = last; pump(); }
  }, opts.heartbeatMs ?? TRANSFER_HEARTBEAT_MS);
  heartbeat.unref?.();
  return {
    report(r: PeerTransferReport) {
      if (finished) return;
      last = next = r;
      if (r.phase === "done" || r.phase === "failed") {
        finished = true;
        clearInterval(heartbeat);
      }
      pump();
    },
    cancelled: () => cancelled,
    settled: () => busy ?? Promise.resolve(),
  };
}

