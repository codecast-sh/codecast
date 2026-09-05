import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "../config/types.js";
import { buildLogReport, readSleepWindows, type LogReport, type SleepWindow } from "./logReport.js";
import { readLoopbackIdentity, localAuthHeaders, runRouteProbes, benchClock, type ProbeIdentity, type RouteProbes } from "./probes.js";
import { runLoadBench, type LoadResult, type RuntimeIdentity, type LoadIO } from "./load.js";
import { childProcess } from "./fixture.js";

export interface BenchDeps {
  config: Config;
  siteUrl: string;
  apiToken: string;
  version: string;
  configDir: string;
  getDaemonPid: () => number | null;
  readDaemonState: () => { connected?: boolean; lastHeartbeatTick?: number; runtimeVersion?: string } | null;
}
export interface BenchOptions {
  load?: number;
  sample: number;
  durationMs: number;
  logSinceMs: number;
  json: boolean;
  keep: boolean;
  projectDir?: string;
  churnIntervalMs: number;
  signal?: AbortSignal;
}
export interface BenchContext {
  at: string;
  runtime: RuntimeIdentity;
  daemonConnected: boolean | null;
  heartbeatAgeMs: number | null;
  cliVersion: string;
  testerRuntime: string;
  loadAvg: number[];
  processCount: number | null;
  tmuxPanes: number | null;
  freeMemMb: number;
  port: number | null;
  termAuth: string;
  source: { commit: string | null; dirty: { path: string; status: string; sha256: string | null }[]; error: string | null };
  diskWorkerSetting: boolean;
}
export interface BenchReport {
  schema: 2;
  startedAt: string;
  finishedAt: string;
  context: BenchContext | null;
  after: BenchContext | null;
  observe: RouteProbes | null;
  log: LogReport | null;
  sleepWindows: SleepWindow[];
  sleepCoverage: "darwin pmset historical only" | "unavailable";
  load: LoadResult | null;
  errors: string[];
  acceptance: { status: "FAIL" | "NOT ESTABLISHED"; reasons: string[] };
  notes: string[];
  outputs: { json: string; md: string };
}
export const BENCH_NOTES = [
  "Health HTTP RTT includes client scheduling and network; it is not a direct main-loop timer measurement.",
  "Observe hooks use invalid dispatch (HTTP 400). Load hooks require a verified owned stub and HTTP 200.",
  "Successful percentiles exclude failures; raw records and full scheduled denominators retain every outcome.",
  "Missing boot/listen markers, runtime config or routing evidence means NOT ESTABLISHED. Mapping is not boot blackout.",
  "Persisted daemon.build is an observed boot marker, not proof of a disk source checkout or current worker routing.",
  "Sleep windows are retained separately. Historical log classification is heuristic and does not excuse missing probe slots.",
  "The bench never starts or restarts a daemon. Worker-off/on live runs require parent coordination.",
];
const hash = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const optionalRead = (file: string) => fs.readFile(file, "utf8").catch(() => null);

export async function observeRuntime(deps: BenchDeps): Promise<RuntimeIdentity> {
  const pid = deps.getDaemonPid();
  const [build, processIdentity] = await Promise.all([
    optionalRead(path.join(deps.configDir, "daemon.build")),
    pid ? childProcess("ps", ["-p", String(pid), "-o", "pid=,uid=,lstart=,comm="]).then(s => s.trim(), () => null) : null,
  ]);
  const afterPid = deps.getDaemonPid();
  return { pid: afterPid, processIdentity: pid === afterPid ? processIdentity : null, build: pid === afterPid && processIdentity ? build?.trim() || null : null,
    runtime: deps.readDaemonState()?.runtimeVersion ?? null, workerSetting: null, workerRouting: null, configHash: null };
}

export async function benchContext(deps: BenchDeps, identity: ProbeIdentity): Promise<BenchContext> {
  const state = deps.readDaemonState();
  const [runtime, processes, panes] = await Promise.all([
    observeRuntime(deps),
    childProcess("ps", ["-axo", "pid="]).then(s => s.trim().split("\n").length, () => null),
    childProcess("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]).then(s => s.trim().split("\n").length, () => null),
  ]);
  const source: BenchContext["source"] = { commit: null, dirty: [], error: null };
  try {
    const root = (await childProcess("git", ["rev-parse", "--show-toplevel"])).trim();
    source.commit = (await childProcess("git", ["rev-parse", "HEAD"])).trim();
    const rows = (await childProcess("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; if (!row) continue;
      const file = row.slice(3);
      if (/[RC]/.test(row.slice(0, 2))) i++;
      const content = await fs.readFile(path.join(root, file)).catch(() => null);
      source.dirty.push({ path: file, status: row.slice(0, 2), sha256: content ? hash(content) : null });
    }
  } catch { source.error = "source manifest unavailable or incomplete"; }
  return { at: new Date().toISOString(), runtime, daemonConnected: state?.connected ?? null,
    heartbeatAgeMs: state?.lastHeartbeatTick ? Date.now() - state.lastHeartbeatTick : null,
    cliVersion: deps.version, testerRuntime: `${process.release.name} ${process.version}${typeof Bun !== "undefined" ? ` Bun ${Bun.version}` : ""}`,
    loadAvg: os.loadavg(), processCount: processes, tmuxPanes: panes, freeMemMb: Math.round(os.freemem() / 1024 / 1024), port: identity.port,
    termAuth: identity.token ? "available (private credential omitted)" : `unavailable: ${identity.reason}`, source, diskWorkerSetting: deps.config.daemon_workers === true };
}

export interface DaemonBenchIO {
  identity: () => ProbeIdentity;
  context: (identity: ProbeIdentity) => Promise<BenchContext>;
  routes: typeof runRouteProbes;
  load: typeof runLoadBench;
  loadIO?: Partial<LoadIO>;
  logs: () => Promise<{ log: LogReport; windows: SleepWindow[] }>;
  write: (file: string, value: string) => Promise<void>;
}

export async function runDaemonBench(deps: BenchDeps, opts: BenchOptions, say: (line: string) => void = console.log, overrides: Partial<DaemonBenchIO> = {}): Promise<BenchReport> {
  const startedAt = new Date().toISOString();
  const prefix = path.join(deps.configDir, "bench", `${startedAt.replaceAll(":", "-")}-${process.pid}`);
  const r: BenchReport = { schema: 2, startedAt, finishedAt: startedAt, context: null, after: null, observe: null, log: null, sleepWindows: [], sleepCoverage: process.platform === "darwin" ? "darwin pmset historical only" : "unavailable", load: null, errors: [], acceptance: { status: "NOT ESTABLISHED", reasons: [] }, notes: BENCH_NOTES, outputs: { json: `${prefix}.json`, md: `${prefix}.md` } };
  const io: DaemonBenchIO = { identity: () => readLoopbackIdentity(deps.configDir), context: identity => benchContext(deps, identity), routes: runRouteProbes, load: runLoadBench,
    logs: async () => { const windows = readSleepWindows(); const raw = await optionalRead(path.join(deps.configDir, "daemon.log")); if (raw === null) throw new Error("daemon log unavailable"); return { log: buildLogReport(raw.split("\n"), { sinceMs: Date.now() - opts.logSinceMs, sleepWindows: windows }), windows }; },
    write: async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value, { mode: 0o600, flag: "wx" }); }, ...overrides };
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(new DOMException("bench cancelled", "AbortError"));
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  if (opts.signal?.aborted) abort(); else opts.signal?.addEventListener("abort", abort, { once: true });
  let identity: ProbeIdentity | null = null;
  try {
    identity = io.identity();
    r.context = await io.context(identity);
    if (identity.port === null) throw new Error("no loopback port");
    const authHeaders = identity.token ? localAuthHeaders(identity.port, identity.token) : null;
    say(`observing health HTTP RTT for ${opts.durationMs}ms`);
    r.observe = await io.routes({ port: identity.port, durationMs: opts.durationMs, authHeaders, signal: cancellation.signal });
    cancellation.signal.throwIfAborted();
    if (opts.load && opts.load > 0) r.load = await io.load({ ...deps, observeRuntime: async () => (await io.context(io.identity())).runtime }, { n: opts.load, sample: opts.sample, durationMs: opts.durationMs, churnIntervalMs: opts.churnIntervalMs, keep: opts.keep, projectDir: opts.projectDir, port: identity.port, authHeaders, signal: cancellation.signal }, say, io.loadIO);
  } catch { r.errors.push(cancellation.signal.aborted ? "bench cancelled" : "benchmark operation failed; inspect partial records"); }
  finally {
    try { r.after = await io.context(io.identity()); } catch { r.errors.push("after identity unavailable"); }
    try { const logs = await io.logs(); r.log = logs.log; r.sleepWindows = logs.windows; } catch { r.errors.push("log or sleep evidence unavailable"); }
    (process as NodeJS.EventEmitter).off("SIGINT", abort); (process as NodeJS.EventEmitter).off("SIGTERM", abort); opts.signal?.removeEventListener("abort", abort);
  }
  const reasons = [...r.errors, ...(r.load?.acceptance.reasons ?? ["load delivery not measured"])];
  if (!r.context || !r.after || JSON.stringify(r.context.runtime) !== JSON.stringify(r.after.runtime)) reasons.push("runtime identity drift or missing");
  if (!r.context || !r.after || JSON.stringify(r.context.source) !== JSON.stringify(r.after.source)) reasons.push("source manifest drift or missing");
  if (!r.observe?.termSessions) reasons.push("authenticated terminal evidence missing");
  if (!r.context?.runtime.workerRouting || r.context.runtime.workerSetting === null || !r.context.runtime.configHash) reasons.push("running configuration/routing not established");
  reasons.push("coordinated boot blackout and independent F3 acceptance not established");
  r.acceptance = { status: r.errors.length || r.load?.acceptance.status === "FAIL" ? "FAIL" : "NOT ESTABLISHED", reasons };
  r.finishedAt = new Date().toISOString();
  const secrets = [deps.apiToken, identity?.token].filter((s): s is string => !!s);
  const redacted = JSON.parse(JSON.stringify(r, (_key, value) => typeof value === "string" ? secrets.reduce((s, token) => s.replaceAll(token, "[redacted]"), value) : value)) as BenchReport;
  try { await io.write(r.outputs.json, JSON.stringify(redacted, null, 2)); await io.write(r.outputs.md, renderMarkdown(redacted)); }
  catch { redacted.errors.push("report persistence failed"); redacted.acceptance.status = "FAIL"; redacted.acceptance.reasons.push("report persistence failed"); say(JSON.stringify(redacted)); }
  return redacted;
}

export function renderMarkdown(r: BenchReport): string {
  const lines = [`# Daemon measurement ${r.startedAt}`, "", `**${r.acceptance.status}**`, "", ...r.acceptance.reasons.map(reason => `- ${reason}`), "", "| Route | Successful / scheduled | p99 / max RTT ms | Errors / timeouts / cancelled / skipped / missing | Tester lateness max ms |", "| --- | --- | --- | --- | --- |"];
  for (const [phase, routes] of [["observe", r.observe], ["load", r.load]] as const) {
    for (const probe of [routes?.loopLag, routes?.hookStatus, routes?.termSessions]) if (probe) lines.push(`| ${phase}: ${probe.label} | ${probe.summary.n} / ${probe.expected} | ${probe.summary.p99 ?? "unknown"} / ${probe.summary.max ?? "unknown"} | ${probe.errors} / ${probe.timeouts} / ${probe.cancelled} / ${probe.skipped} / ${probe.missing} | ${probe.lateness.max ?? "unknown"} |`);
  }
  if (r.load) lines.push("", `Fleet: ${r.load.spawned}/${r.load.n} spawned, ${r.load.mapped}/${r.load.n} mapped. Delivery: ${r.load.echoedMs.n}/${r.load.sampleRequested} assistant echoes. Cleanup: ${r.load.teardown.verified ? "verified" : "unverified"}.`, "", `Cleanup failures: ${r.load.teardown.warnings.join("; ") || "none"}`);
  lines.push("", "Runtime before/after, source manifests, phase timestamps, full probe slots, delivery legs, sleep windows and cleanup ledger are retained in JSON.", "", ...r.notes.map(note => `- ${note}`), "", `JSON: ${r.outputs.json}`, "");
  return lines.join("\n");
}
