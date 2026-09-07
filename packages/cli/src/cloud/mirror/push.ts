/**
 * Laptop side of the home mirror: build the bundle, ship it over ssh stdin
 * to the host's own `cast cloud mirror-apply --stdin`, remember what each
 * host has (~/.codecast/browser/mirror-pushes.json) so the daemon's 60s tick
 * and every spawn skip a push the host already holds.
 *
 * Failures never wake a box and never retry every minute: a host whose push
 * failed is left alone on the fast tick until the local hash changes, the
 * 30-minute verify tick, or an explicit `cast hosts sync`. A REFUSAL
 * (other user/device/home, unprovisioned, an older cast) is final for the
 * bundle that earned it: nothing re-uploads it until the bundle changes or
 * a forced push (`cast hosts sync`, provisioning) asks again.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../atomicWrite.js";
import { localConfigDir, readLocalConfig } from "../../config/readLocalConfig.js";
import { isCloudMirrorEnabled, type Config } from "../../config/types.js";
import { deviceId as localDeviceId } from "../../remote/device.js";
import { remoteHome, sshBase, type RemoteHost } from "../../remote/session-move.js";
import { withMirrorLock, type ApplyResult, type MirrorStamp } from "./apply.js";
import { buildMirrorBundle, sha256, type BuiltBundle } from "./bundle.js";
import { MIRROR_MANAGED_ROOTS, collectMirrorFiles, type Inventory } from "./inventory.js";
import { projectDestination, projectPathMappings, readProjectRegistrations, type ProjectRegistration } from "./projectRefresh.js";
import { collectProjectContext } from "./discovery.js";
import { transformByKind, type MirrorKind } from "./transform.js";

export const MIRROR_APPLY_COMMAND = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; cast cloud mirror-apply --stdin';
export const MIRROR_PUSH_TIMEOUT_MS = 60_000;
export const OLDER_HOST_REASON = "host cast older than this laptop — cast hosts provision";
export const NOT_LOGGED_IN_REASON = "not logged in on this laptop — cast login";

/** Reasons a host will keep giving for the same bundle: not retried without force. */
export const FINAL_REFUSALS: ReadonlySet<string> = new Set(["other_user", "other_device", "other_home"]);
export const MIRROR_RETRY_MS = 60_000;
export const MIRROR_REFUSAL_RETRY_MS = 5 * 60_000;

export function hostKey(host: RemoteHost): string {
  return `${host.user}@${host.address}`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface HomeMirrorSummary {
  files: Array<{ path: string; kind: MirrorKind; mode: string; size: number }>;
  skipped: Array<{ path: string; reason: string }>;
  scrubbed: string[];
  excludesApplied: string[];
  gitIdentity: Inventory["gitIdentity"];
  totalBytes: number;
}

export interface HomeMirror extends BuiltBundle {
  summary: HomeMirrorSummary;
}

export interface BuildHomeMirrorOptions {
  config: Config | null | undefined;
  hostHome: string;
  home?: string;
  localGitRoot?: string;
  takeOver?: boolean;
  deviceId?: string;
  castVersion?: string;
  gitEnv?: NodeJS.ProcessEnv;
  projects?: ProjectRegistration[];
}

/** Collect + transform + bundle. Throws when the inventory refuses (size cap). */
export async function buildHomeMirror(opts: BuildHomeMirrorOptions): Promise<HomeMirror> {
  const home = opts.home ?? (process.env.HOME || os.homedir());
  const inv = await collectMirrorFiles({ home, config: opts.config, hostHome: opts.hostHome, localGitRoot: opts.localGitRoot, gitEnv: opts.gitEnv });
  const projects = opts.projects ?? [];
  const ctx = { fromHome: home, toHome: opts.hostHome, pathMappings: projects.flatMap((p) => projectPathMappings(p, home, opts.hostHome)) };
  const scrubbed: string[] = [];
  const skipped = [...inv.skipped];
  const entries: Array<{ path: string; kind: MirrorKind; mode: "0600" | "0700"; bytes: Buffer }> = [];
  const add = (e: { path: string; kind: MirrorKind; mode: "0600" | "0700"; bytes: Buffer }, context = ctx) => {
    const transformed = transformByKind(e.kind, e.bytes, context);
    const existing = entries.find((f) => f.path === e.path);
    if (existing) {
      if (!existing.bytes.equals(transformed.bytes) || existing.mode !== e.mode) throw new Error(`conflicting context sources for ${e.path}`);
      return;
    }
    entries.push({ ...e, bytes: transformed.bytes });
    for (const item of transformed.scrubbed) scrubbed.push(`${e.path}: ${item}`);
  };
  for (const e of inv.entries) add(e);
  for (const project of projects) {
    if (!(await fs.promises.stat(project.sourceRoot)).isDirectory()) throw new Error(`project context root is not a directory: ${project.sourceRoot}`);
    const discovered = await collectProjectContext({ root: project.sourceRoot, home, includeTracked: true, includeAncestors: true, config: opts.config });
    skipped.push(...discovered.skipped);
    const context = { fromHome: home, toHome: opts.hostHome, pathMappings: projectPathMappings(project, home, opts.hostHome) };
    for (const file of discovered.files) add({ path: projectDestination(file.sourcePath, project, home, opts.hostHome), kind: file.kind, mode: file.mode, bytes: file.bytes }, context);
  }
  const failures = skipped.filter((s) => /unparseable|unreadable|read failed|failed to read|missing reference|dangling symlink/i.test(s.reason));
  if (failures.length) throw new Error(`incomplete context inventory: ${failures.map((s) => `${s.path}: ${s.reason}`).join("; ")}`);
  const built = buildMirrorBundle(entries, {
    source: {
      device_id: opts.deviceId ?? localDeviceId(),
      user_id: opts.config?.user_id ?? "",
      home,
      platform: process.platform,
      cast_version: opts.castVersion ?? "",
    },
    target_home: opts.hostHome,
    project_roots: projects.map((p) => path.posix.relative(opts.hostHome, p.targetRoot)),
    managed_roots: [...new Set([...MIRROR_MANAGED_ROOTS, ...entries.map((e) => e.path)])],
    take_over: opts.takeOver ?? false,
    skipped,
    scrubbed,
    excludes_applied: inv.excludesApplied,
  });
  return {
    ...built,
    summary: {
      files: built.header.files.map((f) => ({ path: f.path, kind: f.kind, mode: f.mode, size: f.size })),
      skipped,
      scrubbed,
      excludesApplied: inv.excludesApplied,
      gitIdentity: inv.gitIdentity,
      totalBytes: built.header.files.reduce((n, f) => n + f.size, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface MirrorPushOutcome {
  pushed: boolean;
  hash?: string;
  result?: ApplyResult;
  /** Why nothing was applied (a refusal, an older host). Transport errors throw. */
  reason?: string;
}

function lastJsonLine(out: string): unknown {
  const line = out.trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function isApplyResult(value: unknown): value is ApplyResult {
  const r = value as ApplyResult | null;
  return !!r && typeof r.hash === "string" && Array.isArray(r.applied) && Array.isArray(r.errors)
    && Array.isArray(r.host_edited) && Array.isArray(r.pruned) && typeof r.unchanged === "number";
}

function applyFailure(r: ApplyResult): string {
  return [r.refused, ...r.errors.map((e) => `${e.path}: ${e.error}`), ...r.host_edited.map((p) => `${p}: remote edit conflict`)].filter(Boolean).join("; ");
}

/**
 * Stream one bundle to the host's `cast cloud mirror-apply --stdin` and read
 * its one-line JSON reply. Exit 3 is a refusal (reason in the reply); an
 * `unknown command` reply is an older host. Neither the bundle nor the
 * host's stdout ever appears in an error message.
 */
export async function pushMirrorToHostAsync(host: RemoteHost, bundle: Buffer, opts: { timeoutMs?: number; signal?: AbortSignal; command?: string } = {}): Promise<MirrorPushOutcome> {
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("ssh", [...sshBase(host), hostKey(host), opts.command ?? MIRROR_APPLY_COMMAND], { stdio: ["pipe", "pipe", "pipe"], signal: opts.signal, killSignal: "SIGKILL" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("mirror push timed out"));
    }, opts.timeoutMs ?? MIRROR_PUSH_TIMEOUT_MS);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (c) => { clearTimeout(timer); resolve({ code: c, stdout: out, stderr: err }); });
    child.stdin.on("error", () => { /* the host closed early; the exit code tells the story */ });
    child.stdin.end(bundle);
  });
  const reply = lastJsonLine(stdout) as ApplyResult | null;
  if (isApplyResult(reply) && (reply.errors.length || reply.host_edited.length)) {
    return { pushed: false, hash: reply.hash, result: reply, reason: applyFailure(reply) };
  }
  if (code === 0 && isApplyResult(reply) && !reply.refused) {
    return { pushed: true, hash: reply.hash, result: reply };
  }
  if (code === 3) {
    return { pushed: false, reason: reply?.refused ?? "refused", result: reply ?? undefined };
  }
  // An older cast answers `unknown command`; a box with no cast on PATH at all
  // answers `not found` / exit 127. Both are cured by provisioning.
  if (code === 127 || /unknown command|error: unknown|not found/i.test(stderr)) return { pushed: false, reason: OLDER_HOST_REASON };
  const brief = stderr.trim().split("\n").filter(Boolean).pop()?.slice(0, 160);
  throw new Error(`mirror push failed (exit ${code ?? "signal"})${brief ? `: ${brief}` : ""}`);
}

/** The host's ~/.codecast/mirror.json, or null when absent/unreadable. */
export async function readRemoteMirrorStamp(host: RemoteHost, timeoutMs = 20_000, signal?: AbortSignal): Promise<MirrorStamp | null> {
  const out = await new Promise<string | null>((resolve) => {
    const child = spawn("ssh", [...sshBase(host), hostKey(host), MIRROR_APPLY_COMMAND.replace("--stdin", "--verify")], { stdio: ["ignore", "pipe", "ignore"], signal, killSignal: "SIGKILL" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
    let buf = "";
    child.stdout?.on("data", (d) => { buf += d; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? buf : null); });
  });
  if (!out) return null;
  try {
    const parsed = lastJsonLine(out) as MirrorStamp | null;
    return parsed && typeof parsed === "object" && typeof parsed.hash === "string" && parsed.complete === true ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Laptop stamps
// ---------------------------------------------------------------------------

export interface LocalMirrorStamp {
  hash: string;
  at: string;
  last_failure?: { reason: string; at: string; hash: string };
}

export type LocalMirrorStamps = Record<string, LocalMirrorStamp>;

export function localStampsFile(): string {
  return path.join(localConfigDir(), "browser", "mirror-pushes.json");
}

export function readLocalStamps(file = localStampsFile()): LocalMirrorStamps {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLocalStamps(stamps: LocalMirrorStamps, file = localStampsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFile(file, JSON.stringify(stamps, null, 2) + "\n", { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// One host, now (prepare / move / provision / `cast hosts sync`)
// ---------------------------------------------------------------------------

export interface MirrorHomeOptions {
  onProgress?: (m: string) => void;
  /** Push even when the local stamp says the host is in step. */
  force?: boolean;
  takeOver?: boolean;
  config?: Config | null;
  localGitRoot?: string;
  onlyIfChanged?: boolean;
  signal?: AbortSignal;
  /** Injection for tests. */
  deps?: Partial<MirrorDeps>;
}

export interface MirrorHomeOutcome extends MirrorPushOutcome {
  /** Set when no bundle was uploaded: the host is in step, or refused this same bundle before. */
  skipped?: "in step" | "refused earlier";
  changed: number;
}

const localQueues = new Map<string, Promise<unknown>>();

async function queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = localQueues.get(key) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(fn);
  localQueues.set(key, run);
  try { return await run; } finally { if (localQueues.get(key) === run) localQueues.delete(key); }
}

function resolveDeps(partial: Partial<MirrorDeps> = {}, signal?: AbortSignal): MirrorDeps {
  const defaults = defaultDeps(signal);
  return { ...defaults, ...partial, lock: partial.lock ?? (partial.readLocalStamps ? queued : defaults.lock) };
}

async function saveHostStamp(deps: MirrorDeps, key: string, stamp: LocalMirrorStamp): Promise<void> {
  await deps.lock("stamps", async () => {
    const latest = deps.readLocalStamps();
    deps.writeLocalStamps({ ...latest, [key]: stamp });
  });
}

export async function mirrorHomeToHost(host: RemoteHost, opts: MirrorHomeOptions = {}): Promise<MirrorHomeOutcome> {
  const deps = resolveDeps(opts.deps, opts.signal);
  return deps.lock(hostKey(host), async () => {
    const config = opts.config === undefined ? deps.readConfig() : opts.config;
    if (!isCloudMirrorEnabled(config)) return { pushed: false, reason: "config mirror disabled", changed: 0 };
    if (!config?.user_id) return { pushed: false, reason: NOT_LOGGED_IN_REASON, changed: 0 };
    opts.signal?.throwIfAborted();
    const built = await deps.build({ config, hostHome: remoteHome(host), takeOver: opts.takeOver, localGitRoot: opts.localGitRoot, projects: deps.readProjects(host) });
    const key = hostKey(host);
    const mine = deps.readLocalStamps()[key];
    const at = deps.now().toISOString();
    if (opts.onlyIfChanged && !opts.force) {
      if (mine?.hash === built.hash && !mine.last_failure) return { pushed: false, hash: built.hash, skipped: "in step", changed: 0 };
      if (mine?.last_failure?.hash === built.hash) {
        const delay = FINAL_REFUSALS.has(mine.last_failure.reason) ? MIRROR_REFUSAL_RETRY_MS : MIRROR_RETRY_MS;
        if (deps.now().getTime() - Date.parse(mine.last_failure.at) < delay) return { pushed: false, reason: mine.last_failure.reason, skipped: "refused earlier", changed: 0 };
      }
    }
    try {
      if (!opts.force) {
        const remote = await deps.readStamp(host);
        if (remote?.complete === true && remote.hash === built.hash) {
          await saveHostStamp(deps, key, { hash: built.hash, at });
          return { pushed: false, hash: built.hash, skipped: "in step", changed: 0 };
        }
      }
      opts.signal?.throwIfAborted();
      let r = await deps.push(host, built.bytes);
      if (r.pushed && (!isApplyResult(r.result) || r.result.hash !== built.hash || r.hash !== built.hash || r.result.refused || r.result.errors.length || r.result.host_edited.length)) {
        r = { ...r, pushed: false, reason: isApplyResult(r.result) ? applyFailure(r.result) || "receiver returned a different bundle hash" : "receiver returned an incomplete apply result" };
      }
      if (r.pushed) {
        await saveHostStamp(deps, key, { hash: built.hash, at });
        return { ...r, changed: (r.result?.applied.length ?? 0) + (r.result?.pruned.length ?? 0) };
      }
      await saveHostStamp(deps, key, { hash: "", at, last_failure: { reason: r.reason ?? "refused", at, hash: built.hash } });
      return { ...r, changed: 0 };
    } catch (err) {
      await saveHostStamp(deps, key, { hash: "", at, last_failure: { reason: err instanceof Error ? err.message : String(err), at, hash: built.hash } });
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// The daemon tick
// ---------------------------------------------------------------------------

export interface MirrorDeps {
  listHosts: () => Promise<RemoteHost[]>;
  readStamp: (host: RemoteHost) => Promise<MirrorStamp | null>;
  push: (host: RemoteHost, bundle: Buffer) => Promise<MirrorPushOutcome>;
  build: (opts: Omit<BuildHomeMirrorOptions, "hostHome"> & { hostHome: string }) => Promise<BuiltBundle>;
  readLocalStamps: () => LocalMirrorStamps;
  writeLocalStamps: (s: LocalMirrorStamps) => void;
  readConfig: () => Config | null;
  log: (m: string) => void;
  now: () => Date;
  /** Failure reasons already logged, per host — one line per distinct reason. */
  loggedFailures: Set<string>;
  lock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  readProjects: (host: RemoteHost) => ProjectRegistration[];
}

export interface MirrorTickOptions {
  reason: string;
  /** Fast tick: no ssh unless the local hash differs from what a host last got. */
  onlyIfChanged?: boolean;
  /** Periodic tick: read each host's stamp and push on mismatch. */
  verifyRemote?: boolean;
  signal?: AbortSignal;
}

const moduleLoggedFailures = new Set<string>();

export function defaultDeps(signal?: AbortSignal): MirrorDeps {
  return {
    listHosts: async () => [],
    readStamp: (host) => readRemoteMirrorStamp(host, 20_000, signal),
    push: (host, bundle) => pushMirrorToHostAsync(host, bundle, { signal }),
    build: buildHomeMirror,
    readLocalStamps: () => readLocalStamps(),
    writeLocalStamps: (s) => writeLocalStamps(s),
    readConfig: readLocalConfig,
    log: () => {},
    now: () => new Date(),
    loggedFailures: moduleLoggedFailures,
    lock: (key, fn) => withMirrorLock(path.join(localConfigDir(), "mirror-locks", sha256(key)), fn, signal),
    readProjects: (host) => readProjectRegistrations(host),
  };
}

export interface MirrorTickReport {
  pushed: string[];
  skipped: string[];
  failed: string[];
}

/**
 * One pass over every reachable host. Never wakes a box (listHosts is the
 * caller's TCP-probed list), never retries a failed host on the fast tick.
 */
export async function runMirrorTick(opts: MirrorTickOptions, partial: Partial<MirrorDeps> = {}): Promise<MirrorTickReport> {
  const deps = resolveDeps(partial, opts.signal);
  const report: MirrorTickReport = { pushed: [], skipped: [], failed: [] };
  const config = deps.readConfig();
  if (!isCloudMirrorEnabled(config)) return report;
  for (const host of await deps.listHosts()) {
    opts.signal?.throwIfAborted();
    const key = hostKey(host);
    try {
      const r = await mirrorHomeToHost(host, { config, deps, signal: opts.signal, onlyIfChanged: opts.onlyIfChanged && !opts.verifyRemote });
      if (r.pushed) {
        report.pushed.push(key);
        deps.log(`mirrored ${r.changed} changed config file(s) to ${key} (${opts.reason}, ${(r.hash ?? "").slice(0, 8)})`);
        for (const failure of deps.loggedFailures) if (failure.startsWith(`${key}|`)) deps.loggedFailures.delete(failure);
      } else if (r.skipped === "in step" || r.skipped === "refused earlier" || r.reason === NOT_LOGGED_IN_REASON) {
        report.skipped.push(key);
        if (r.reason) logFailureOnce(deps, key, r.reason, opts.reason);
      } else {
        report.failed.push(key);
        logFailureOnce(deps, key, r.reason ?? "incomplete mirror", opts.reason);
      }
    } catch (err) {
      report.failed.push(key);
      logFailureOnce(deps, key, err instanceof Error ? err.message : String(err), opts.reason);
    }
  }
  return report;
}

function logFailureOnce(deps: MirrorDeps, key: string, reason: string, tick: string): void {
  const stampKey = `${key}|${reason}`;
  if (deps.loggedFailures.has(stampKey)) return;
  deps.loggedFailures.add(stampKey);
  const hint = reason === "unprovisioned" ? " — cast hosts provision <id>"
    : reason === "other_device" ? " — another laptop owns this host's config; cast hosts sync --take-over to take it"
    : reason === "other_user" ? " — the host belongs to another codecast user"
    : reason === "other_home" ? " — the bundle was built for a different home directory than the host's"
    : "";
  deps.log(`mirror to ${key} skipped (${tick}): ${reason}${hint}`);
}

/** For `cast hosts sync --bundle-out`: the bundle on disk, 0600. */
export function writeBundleFile(file: string, bundle: Buffer): void {
  fs.writeFileSync(file, bundle, { mode: 0o600 });
}
