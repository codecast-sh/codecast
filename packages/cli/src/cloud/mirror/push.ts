import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../atomicWrite.js";
import { localConfigDir, readLocalConfig } from "../../config/readLocalConfig.js";
import { isCloudMirrorEnabled, type Config } from "../../config/types.js";
import { deviceId as localDeviceId } from "../../remote/device.js";
import { claudeProjectDirName } from "../../projectPathResolver.js";
import { remoteHome, sshBase, type RemoteHost } from "../../remote/session-move.js";
import { withMirrorLock, type ApplyResult, type MirrorStamp } from "./apply.js";
import { buildMirrorBundle, sha256, type BuiltBundle } from "./bundle.js";
import { MIRROR_MANAGED_ROOTS, collectMirrorFiles, type Inventory } from "./inventory.js";
import { projectDestination, projectPathMappings, readProjectRegistrations, unregisterProjectContext, type ProjectRegistration } from "./projectRefresh.js";
import { collectProjectContextAsync } from "./discovery.js";
import { transformByKind, type MirrorKind } from "./transform.js";

export const MIRROR_APPLY_COMMAND = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; cast cloud mirror-apply --stdin';
export const MIRROR_PUSH_TIMEOUT_MS = 60_000;
export const OLDER_HOST_REASON = "host cast older than this laptop — cast hosts provision";
export const NOT_LOGGED_IN_REASON = "not logged in on this laptop — cast login";

/** Ownership refusals use a longer retry delay. */
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
  warnings: string[];
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
  const projects = (opts.projects ?? []).filter((p) => !p.retired);
  const retired = (opts.projects ?? []).filter((p) => p.retired);
  const canonicalProjects = [...projects].sort((a, b) => a.targetRoot.length - b.targetRoot.length || a.targetRoot.localeCompare(b.targetRoot));
  const discoveries = new Map<string, Awaited<ReturnType<typeof collectProjectContextAsync>>>();
  for (const project of projects) if (!discoveries.has(project.sourceRoot)) {
    if (!(await fs.promises.stat(project.sourceRoot)).isDirectory()) throw new Error(`project context root is not a directory: ${project.sourceRoot}`);
    discoveries.set(project.sourceRoot, await collectProjectContextAsync({ root: project.sourceRoot, home, includeTracked: true, includeAncestors: true, config: opts.config }));
  }
  const mappings = (project: ProjectRegistration) => projectPathMappings(project, home, opts.hostHome, discoveries.get(project.sourceRoot)?.files.map((f) => f.sourcePath));
  const ctx = { fromHome: home, toHome: opts.hostHome, pathMappings: canonicalProjects.flatMap(mappings) };
  const scrubbed: string[] = [];
  const skipped = [...inv.skipped];
  const warnings = [...(inv.warnings ?? [])];
  const entries: Array<{ path: string; kind: MirrorKind; mode: "0600" | "0700"; bytes: Buffer }> = [];
  const byPath = new Map<string, (typeof entries)[number]>();
  const add = (e: { path: string; kind: MirrorKind; mode: "0600" | "0700"; bytes: Buffer }, context = ctx) => {
    let transformed: ReturnType<typeof transformByKind>;
    try {
      transformed = transformByKind(e.kind, e.bytes, context);
      if (e.kind === "claude-mcp") {
        const source = JSON.parse(e.bytes.toString("utf8"));
        const projection = JSON.parse(transformed.bytes.toString("utf8"));
        for (const project of projects) {
          const settings = source.projects?.[project.sourceRoot];
          if (!settings) continue;
          const scoped = transformByKind(e.kind, Buffer.from(JSON.stringify({ projects: { [project.sourceRoot]: settings } })), { fromHome: home, toHome: opts.hostHome, pathMappings: mappings(project) });
          Object.assign(projection.projects ??= {}, JSON.parse(scoped.bytes.toString("utf8")).projects);
          transformed.scrubbed.push(...scoped.scrubbed);
        }
        transformed.bytes = Buffer.from(JSON.stringify(projection, null, 2) + "\n");
      }
    }
    catch (err) { throw new Error(`cannot transform required context ${e.path}: ${err instanceof Error ? err.message : String(err)}`); }
    const existing = byPath.get(e.path);
    if (existing) {
      if (!existing.bytes.equals(transformed.bytes) || existing.mode !== e.mode) throw new Error(`conflicting context sources for ${e.path}`);
      return;
    }
    const entry = { ...e, bytes: transformed.bytes };
    entries.push(entry);
    byPath.set(e.path, entry);
    for (const item of transformed.scrubbed) scrubbed.push(`${e.path}: ${item}`);
  };
  for (const e of inv.entries) {
    add(e);
    for (const project of projects) {
      const prefix = `.claude/projects/${claudeProjectDirName(project.sourceRoot)}/memory/`;
      if (e.path.startsWith(prefix)) add({ ...e, path: `.claude/projects/${claudeProjectDirName(project.targetRoot)}/memory/${e.path.slice(prefix.length)}` }, { fromHome: home, toHome: opts.hostHome, pathMappings: mappings(project) });
    }
  }
  for (const project of projects) {
    const discovered = discoveries.get(project.sourceRoot)!;
    skipped.push(...discovered.skipped);
    warnings.push(...discovered.warnings);
    const context = { fromHome: home, toHome: opts.hostHome, pathMappings: mappings(project) };
    for (const file of discovered.files) {
      const dest = projectDestination(file.sourcePath, project, home, opts.hostHome);
      const scoped = file.scope === "project" || dest !== path.relative(home, file.sourcePath);
      add({ path: dest, kind: file.kind, mode: file.mode, bytes: file.bytes }, scoped ? context : ctx);
    }
  }
  const failures = skipped.filter((s) => /unparseable|unreadable|read failed|failed to read|missing reference|dangling/i.test(s.reason));
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
    unmanaged_roots: retired.flatMap((p) => [path.posix.relative(opts.hostHome, p.targetRoot), `.claude/projects/${claudeProjectDirName(p.targetRoot)}/memory`]),
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
      warnings: [...new Set(warnings)],
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
async function mirrorSsh(host: RemoteHost, command: string, opts: { input?: Buffer; timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  opts.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshBase(host), hostKey(host), command], { stdio: ["pipe", "pipe", "pipe"] });
    let failure: Error | undefined;
    const cancel = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => cancel(new Error("mirror operation aborted"));
    const timer = setTimeout(() => cancel(new Error("mirror push timed out")), opts.timeoutMs);
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > 32 * 1024 * 1024) cancel(new Error("mirror reply exceeds receive limit")); });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4096); });
    child.on("error", (err) => { failure ??= err; });
    child.on("close", async (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      if (failure && child.pid) {
        const deadline = performance.now() + 1_000;
        for (;;) {
          try { process.kill(child.pid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
            reject(new Error("mirror SSH cleanup unconfirmed: cannot verify process exit"));
            return;
          }
          if (performance.now() >= deadline) {
            reject(new Error("mirror SSH cleanup unconfirmed: process remains after close"));
            return;
          }
          await new Promise((done) => setTimeout(done, 10));
        }
      }
      if (failure) reject(failure); else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);
  });
}

export async function pushMirrorToHostAsync(host: RemoteHost, bundle: Buffer, opts: { timeoutMs?: number; signal?: AbortSignal; command?: string } = {}): Promise<MirrorPushOutcome> {
  const command = `gzip -dc | ( ${opts.command ?? MIRROR_APPLY_COMMAND} )`;
  const { code, stdout, stderr } = await mirrorSsh(host, command, { input: gzipSync(bundle), timeoutMs: opts.timeoutMs ?? MIRROR_PUSH_TIMEOUT_MS, signal: opts.signal });
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
  if (code !== 0 && /unsupported mirror bundle version|not a mirror bundle \(bad magic\)/.test(String((reply as unknown as { error?: string })?.error ?? ""))) return { pushed: false, reason: OLDER_HOST_REASON };
  // An older cast answers `unknown command`; a box with no cast on PATH at all
  // answers `not found` / exit 127. Both are cured by provisioning.
  if (code === 127 || /unknown command|error: unknown|not found/i.test(stderr)) return { pushed: false, reason: OLDER_HOST_REASON };
  const brief = stderr.trim().split("\n").filter(Boolean).pop()?.slice(0, 160);
  throw new Error(`mirror push failed (exit ${code ?? "signal"})${brief ? `: ${brief}` : ""}`);
}

/** The host stamp after verification against actual bytes and modes. */
export async function readRemoteMirrorStamp(host: RemoteHost, timeoutMs = 20_000, signal?: AbortSignal, command = MIRROR_APPLY_COMMAND.replace("--stdin", "--verify"), strict = false): Promise<MirrorStamp | null> {
  const response = await mirrorSsh(host, command, { timeoutMs, signal });
  if (strict && response.code !== 0) throw new Error(response.stderr.trim() || `mirror verification failed (exit ${response.code})`);
  const out = response.code === 0 ? response.stdout : null;
  if (!out) return null;
  try {
    const parsed = lastJsonLine(out) as MirrorStamp | null;
    if (parsed === null) return null;
    if (parsed && typeof parsed === "object" && typeof parsed.hash === "string") return parsed;
    if (strict) throw new Error("receiver returned an invalid mirror stamp");
    return null;
  } catch (err) {
    if (strict) throw err;
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
  /** Set when verification succeeds or a failed fast tick is backing off. */
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
  return { ...defaults, ...partial, lock: partial.lock ?? (partial.readLocalStamps ? queued : defaults.lock), retireProjects: partial.retireProjects ?? (partial.readLocalStamps ? async () => {} : defaults.retireProjects) };
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
    const key = hostKey(host);
    let built: BuiltBundle;
    try {
      built = await deps.build({ config, hostHome: remoteHome(host), takeOver: opts.takeOver, localGitRoot: opts.localGitRoot, projects: deps.readProjects(host) });
    } catch (err) {
      const at = deps.now().toISOString();
      await saveHostStamp(deps, key, { hash: "", at, last_failure: { reason: err instanceof Error ? err.message : String(err), at, hash: "" } });
      throw err;
    }
    const summary = (built as Partial<HomeMirror>).summary;
    for (const warning of summary?.warnings ?? []) {
      (opts.onProgress ?? deps.log)(`context compatibility: ${warning}`);
    }
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
      if (r.result?.retired_projects?.length) await deps.retireProjects(host, r.result.retired_projects.map((root) => path.posix.join(remoteHome(host), root)));
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
  retireProjects: (host: RemoteHost, roots: string[]) => Promise<void>;
}

export interface MirrorTickOptions {
  reason: string;
  /** Fast tick: no ssh unless the local hash differs from what a host last got. */
  onlyIfChanged?: boolean;
  /** Periodic tick: verify destination contents and push on mismatch. */
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
    retireProjects: async (host, roots) => { for (const root of roots) await unregisterProjectContext(host, root); },
  };
}

export interface MirrorTickReport {
  pushed: string[];
  skipped: string[];
  failed: string[];
}

/** One pass over the caller's reachable hosts; failed fast ticks use bounded backoff. */
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
