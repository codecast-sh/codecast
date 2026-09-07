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
import type { Config } from "../../config/types.js";
import { deviceId as localDeviceId } from "../../remote/device.js";
import { remoteHome, sshBase, type RemoteHost } from "../../remote/session-move.js";
import type { ApplyResult, MirrorStamp } from "./apply.js";
import { buildMirrorBundle, type BuiltBundle } from "./bundle.js";
import { MIRROR_MANAGED_ROOTS, collectMirrorFiles, type Inventory } from "./inventory.js";
import { transformByKind, type MirrorKind } from "./transform.js";

export const MIRROR_APPLY_COMMAND = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; cast cloud mirror-apply --stdin';
export const MIRROR_PUSH_TIMEOUT_MS = 60_000;
export const OLDER_HOST_REASON = "host cast older than this laptop — cast hosts provision";
export const NOT_LOGGED_IN_REASON = "not logged in on this laptop — cast login";

/** Reasons a host will keep giving for the same bundle: not retried without force. */
export const FINAL_REFUSALS: ReadonlySet<string> = new Set(["other_user", "unprovisioned", "other_device", "other_home", OLDER_HOST_REASON]);

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
}

/** Collect + transform + bundle. Throws when the inventory refuses (size cap). */
export async function buildHomeMirror(opts: BuildHomeMirrorOptions): Promise<HomeMirror> {
  const home = opts.home ?? (process.env.HOME || os.homedir());
  const inv = await collectMirrorFiles({ home, config: opts.config, hostHome: opts.hostHome, localGitRoot: opts.localGitRoot, gitEnv: opts.gitEnv });
  const ctx = { fromHome: home, toHome: opts.hostHome };
  const scrubbed: string[] = [];
  const skipped = [...inv.skipped];
  const entries: Array<{ path: string; kind: MirrorKind; mode: "0600" | "0700"; bytes: Buffer }> = [];
  const extra: string[] = [];
  for (const e of inv.entries) {
    try {
      const t = transformByKind(e.kind, e.bytes, ctx);
      entries.push({ path: e.path, kind: e.kind, mode: e.mode, bytes: t.bytes });
      for (const s of t.scrubbed) scrubbed.push(`${e.path}: ${s}`);
      extra.push(...t.referencedFiles);
    } catch (err) {
      skipped.push({ path: e.path, reason: `unparseable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  // Referenced files the transform discovered that the inventory did not already ship.
  for (const rel of extra) {
    if (entries.some((e) => e.path === rel)) continue;
    const abs = path.join(home, rel);
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile()) continue;
      entries.push({ path: rel, kind: "verbatim", mode: st.mode & 0o100 ? "0700" : "0600", bytes: fs.readFileSync(abs) });
    } catch { /* not there */ }
  }
  const built = buildMirrorBundle(entries, {
    source: {
      device_id: opts.deviceId ?? localDeviceId(),
      user_id: opts.config?.user_id ?? "",
      home,
      platform: process.platform,
      cast_version: opts.castVersion ?? "",
    },
    target_home: opts.hostHome,
    managed_roots: [...MIRROR_MANAGED_ROOTS],
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

/**
 * Stream one bundle to the host's `cast cloud mirror-apply --stdin` and read
 * its one-line JSON reply. Exit 3 is a refusal (reason in the reply); an
 * `unknown command` reply is an older host. Neither the bundle nor the
 * host's stdout ever appears in an error message.
 */
export async function pushMirrorToHostAsync(host: RemoteHost, bundle: Buffer, opts: { timeoutMs?: number } = {}): Promise<MirrorPushOutcome> {
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("ssh", [...sshBase(host), hostKey(host), MIRROR_APPLY_COMMAND], { stdio: ["pipe", "pipe", "pipe"] });
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
  if (code === 0 && reply && typeof reply === "object") {
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
export async function readRemoteMirrorStamp(host: RemoteHost, timeoutMs = 20_000): Promise<MirrorStamp | null> {
  const out = await new Promise<string | null>((resolve) => {
    const child = spawn("ssh", [...sshBase(host), hostKey(host), "cat ~/.codecast/mirror.json 2>/dev/null"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
    let buf = "";
    child.stdout?.on("data", (d) => { buf += d; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? buf : null); });
  });
  if (!out) return null;
  try {
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === "object" && typeof parsed.hash === "string" ? (parsed as MirrorStamp) : null;
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
  /** Injection for tests. */
  deps?: Partial<MirrorDeps>;
}

export interface MirrorHomeOutcome extends MirrorPushOutcome {
  /** Set when no bundle was uploaded: the host is in step, or refused this same bundle before. */
  skipped?: "in step" | "refused earlier";
  changed: number;
}

/**
 * Mirror this laptop's home to one host. Skips the upload when the local
 * stamp already holds the current hash, when the host refused this very
 * bundle before, or — the local stamp being silent about this host (an AWS
 * box comes back from sleep on a new address) — when the host's own stamp
 * says it is in step (one `cat` instead of a bundle). `force` pushes
 * regardless. Records a failure so the daemon's fast tick leaves the host
 * alone.
 */
export async function mirrorHomeToHost(host: RemoteHost, opts: MirrorHomeOptions = {}): Promise<MirrorHomeOutcome> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const config = opts.config === undefined ? deps.readConfig() : opts.config;
  if (!config?.user_id) return { pushed: false, reason: NOT_LOGGED_IN_REASON, changed: 0 };
  const built = await deps.build({ config, hostHome: remoteHome(host), takeOver: opts.takeOver, localGitRoot: opts.localGitRoot });
  const key = hostKey(host);
  const stamps = deps.readLocalStamps();
  const mine = stamps[key];
  const at = deps.now().toISOString();
  if (!opts.force) {
    if (mine?.hash === built.hash) return { pushed: false, hash: built.hash, skipped: "in step", changed: 0 };
    if (mine?.last_failure && mine.last_failure.hash === built.hash && FINAL_REFUSALS.has(mine.last_failure.reason)) {
      return { pushed: false, hash: built.hash, reason: mine.last_failure.reason, skipped: "refused earlier", changed: 0 };
    }
    if (!mine) {
      const remote = await deps.readStamp(host);
      if (remote?.hash === built.hash) {
        stamps[key] = { hash: built.hash, at };
        deps.writeLocalStamps(stamps);
        return { pushed: false, hash: built.hash, skipped: "in step", changed: 0 };
      }
    }
  }
  try {
    const r = await deps.push(host, built.bytes);
    if (r.pushed) {
      stamps[key] = { hash: built.hash, at };
      deps.writeLocalStamps(stamps);
      return { ...r, changed: r.result?.applied.length ?? 0 };
    }
    stamps[key] = { ...(mine ?? { hash: "", at }), last_failure: { reason: r.reason ?? "refused", at, hash: built.hash } };
    deps.writeLocalStamps(stamps);
    return { ...r, changed: 0 };
  } catch (err) {
    stamps[key] = { ...(mine ?? { hash: "", at }), last_failure: { reason: err instanceof Error ? err.message : String(err), at, hash: built.hash } };
    deps.writeLocalStamps(stamps);
    throw err;
  }
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
}

export interface MirrorTickOptions {
  reason: string;
  /** Fast tick: no ssh unless the local hash differs from what a host last got. */
  onlyIfChanged?: boolean;
  /** Periodic tick: read each host's stamp and push on mismatch. */
  verifyRemote?: boolean;
}

const moduleLoggedFailures = new Set<string>();

export function defaultDeps(): MirrorDeps {
  return {
    listHosts: async () => [],
    readStamp: readRemoteMirrorStamp,
    push: pushMirrorToHostAsync,
    build: buildHomeMirror,
    readLocalStamps: () => readLocalStamps(),
    writeLocalStamps: (s) => writeLocalStamps(s),
    readConfig: readLocalConfig,
    log: () => {},
    now: () => new Date(),
    loggedFailures: moduleLoggedFailures,
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
  const deps = { ...defaultDeps(), ...partial };
  const report: MirrorTickReport = { pushed: [], skipped: [], failed: [] };
  const hosts = await deps.listHosts();
  if (!hosts.length) return report;
  const config = deps.readConfig();
  if (!config?.user_id) {
    for (const host of hosts) { report.skipped.push(hostKey(host)); logFailureOnce(deps, hostKey(host), NOT_LOGGED_IN_REASON, opts.reason); }
    return report;
  }
  const stamps = deps.readLocalStamps();
  // Hosts may differ in home; build per distinct target home.
  const builds = new Map<string, BuiltBundle>();
  const buildFor = async (host: RemoteHost) => {
    const home = remoteHome(host);
    let b = builds.get(home);
    if (!b) { b = await deps.build({ config, hostHome: home }); builds.set(home, b); }
    return b;
  };
  let dirty = false;
  for (const host of hosts) {
    const key = hostKey(host);
    const at = deps.now().toISOString();
    try {
      const built = await buildFor(host);
      const mine = stamps[key];
      if (opts.onlyIfChanged) {
        if (mine?.hash === built.hash) { report.skipped.push(key); continue; }
        if (mine?.last_failure?.hash === built.hash) { report.skipped.push(key); continue; }
      }
      // A refusal is final for this bundle: no re-upload on the verify tick either.
      if (mine?.last_failure && mine.last_failure.hash === built.hash && FINAL_REFUSALS.has(mine.last_failure.reason)) {
        report.skipped.push(key);
        continue;
      }
      // No local memory of this host (a new address after a wake): ask its
      // stamp before shipping a bundle it may already hold.
      if (opts.verifyRemote || !mine) {
        const remote = await deps.readStamp(host);
        if (remote?.hash === built.hash) {
          if (mine?.hash !== built.hash || mine.last_failure) { stamps[key] = { hash: built.hash, at }; dirty = true; }
          report.skipped.push(key);
          continue;
        }
      }
      const r = await deps.push(host, built.bytes);
      if (r.pushed) {
        stamps[key] = { hash: built.hash, at };
        dirty = true;
        report.pushed.push(key);
        const n = r.result?.applied.length ?? 0;
        const extra = [
          r.result?.pruned.length ? `${r.result.pruned.length} pruned` : "",
          r.result?.host_edited.length ? `${r.result.host_edited.length} host-edited kept` : "",
        ].filter(Boolean).join(", ");
        deps.log(`mirrored ${n} changed config file(s) to ${key} (${opts.reason}, ${built.hash.slice(0, 8)})${extra ? ` — ${extra}` : ""}`);
        deps.loggedFailures.delete(key);
      } else {
        stamps[key] = { ...(mine ?? { hash: "", at }), last_failure: { reason: r.reason ?? "refused", at, hash: built.hash } };
        dirty = true;
        report.failed.push(key);
        logFailureOnce(deps, key, r.reason ?? "refused", opts.reason);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const mine = stamps[key];
      stamps[key] = { ...(mine ?? { hash: "", at }), last_failure: { reason, at, hash: builds.get(remoteHome(host))?.hash ?? "" } };
      dirty = true;
      report.failed.push(key);
      logFailureOnce(deps, key, reason, opts.reason);
    }
  }
  if (dirty) deps.writeLocalStamps(stamps);
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
