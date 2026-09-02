// `cast bench daemon`: observe the live daemon (loop lag, route latency, the
// daemon.log report) and optionally put N stand-in panes of load on it. Writes
// JSON plus a markdown table to ~/.codecast/bench/<timestamp>.{json,md} so a
// run before a change and a run after it compare side by side.
//
// Leaf module: no daemon.ts import (the daemon is a separate bundle entrypoint).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotProcessTable } from "../processTable.js";
import { tmuxRun } from "../tmux.js";
import { fmt } from "../colors.js";
import type { Config } from "../config/types.js";
import { type SpawnGroup, buildLogReport, readSleepWindows, type LogReport } from "./logReport.js";
import { readLoopbackIdentity, localAuthHeaders, runRouteProbes, type LoopLagResult, type LatencyProbeResult } from "./probes.js";
import { runLoadBench, type LoadResult } from "./load.js";
import type { LatencySummary } from "./stats.js";

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
}

export interface BenchReport {
  schema: 1;
  startedAt: string;
  finishedAt: string;
  context: {
    daemonPid: number | null;
    daemonConnected: boolean | null;
    daemonRuntimeVersion: string | null;
    heartbeatAgeMs: number | null;
    cliVersion: string;
    loadAvg: number[];
    processCount: number;
    tmuxSessions: number;
    freeMemMb: number;
    port: number | null;
    termAuth: string;
  };
  observe: {
    durationMs: number;
    loopLag: LoopLagResult;
    hookStatus: LatencyProbeResult;
    termSessions: LatencyProbeResult | null;
    log: LogReport;
  };
  load: LoadResult | null;
  notes: string[];
  outputs: { json: string; md: string };
}

export const BENCH_NOTES = [
  "/hook/status is timed on its 400 path (no params), so it measures route dispatch on the loop, not status handling.",
  "LOOP-FREEZE lines exist only for stalls of 5s or more; the /health probe is the meter below that.",
  "Sleep is decided from pmset windows (darwin). Without pmset coverage, a gap of 5 minutes or more with under 1% CPU is sleep.",
  "The daemon's own 'Sleep detected' lines are ignored: they call any low CPU gap sleep, including real freezes.",
  "The bench never restarts the daemon and never boots one.",
];

export async function runDaemonBench(deps: BenchDeps, opts: BenchOptions, say: (line: string) => void = console.log): Promise<BenchReport> {
  const startedAt = new Date();
  const identity = readLoopbackIdentity(deps.configDir);
  if (identity.port === null) throw new Error("no hook-port file: is the daemon running? (`cast start`)");
  const port = identity.port;
  const authHeaders = identity.token ? localAuthHeaders(port, identity.token) : null;
  const state = deps.readDaemonState();

  const context: BenchReport["context"] = {
    daemonPid: deps.getDaemonPid(),
    daemonConnected: state?.connected ?? null,
    daemonRuntimeVersion: state?.runtimeVersion ?? null,
    heartbeatAgeMs: state?.lastHeartbeatTick ? Date.now() - state.lastHeartbeatTick : null,
    cliVersion: deps.version,
    loadAvg: os.loadavg().map((v) => Math.round(v * 10) / 10),
    processCount: snapshotProcessTable().length,
    tmuxSessions: tmuxRun(["list-sessions", "-F", "#{session_name}"]).stdout.split("\n").filter(Boolean).length,
    freeMemMb: Math.round(os.freemem() / 1024 / 1024),
    port,
    termAuth: identity.token ? "token from loopback-identity.json" : `no token (${identity.reason})`,
  };
  say(fmt.muted(`  daemon pid ${context.daemonPid ?? "none"} on port ${port}; load ${context.loadAvg.join(" ")}; ${context.processCount} processes; ${context.tmuxSessions} tmux sessions`));

  say(fmt.muted(`  observing for ${Math.round(opts.durationMs / 1000)}s`));
  const { loopLag, hookStatus, termSessions } = await runRouteProbes({ port, durationMs: opts.durationMs, authHeaders });

  say(fmt.muted("  reading daemon.log"));
  const log = buildLogReport(readDaemonLogLines(deps.configDir), {
    sinceMs: Date.now() - opts.logSinceMs,
    sleepWindows: readSleepWindows(),
  });

  let load: LoadResult | null = null;
  if (opts.load && opts.load > 0) {
    say(fmt.muted(`  load: ${opts.load} panes, ${opts.sample} sampled`));
    load = await runLoadBench(
      deps,
      { n: opts.load, sample: opts.sample, durationMs: opts.durationMs, churnIntervalMs: opts.churnIntervalMs, keep: opts.keep, projectDir: opts.projectDir, port, authHeaders },
      (line) => say(fmt.muted(line)),
    );
  }

  const benchDir = path.join(deps.configDir, "bench");
  fs.mkdirSync(benchDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/:/g, "-");
  const outputs = { json: path.join(benchDir, `${stamp}.json`), md: path.join(benchDir, `${stamp}.md`) };
  const report: BenchReport = {
    schema: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    context,
    observe: { durationMs: opts.durationMs, loopLag: { ...loopLag, samples: [] }, hookStatus, termSessions, log },
    load: load ? { ...load, loopLag: load.loopLag ? { ...load.loopLag, samples: [] } : null } : null,
    notes: BENCH_NOTES,
    outputs,
  };
  fs.writeFileSync(outputs.json, JSON.stringify(report, null, 2));
  fs.writeFileSync(outputs.md, renderMarkdown(report));
  return report;
}

function* readDaemonLogLines(configDir: string): Generator<string> {
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(configDir, "daemon.log"), "utf-8");
  } catch {
    return;
  }
  let start = 0;
  while (start < raw.length) {
    const nl = raw.indexOf("\n", start);
    const end = nl === -1 ? raw.length : nl;
    yield raw.slice(start, end);
    start = end + 1;
  }
}

// ── markdown ──────────────────────────────────────────────────────────────────

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${Math.round(v)}ms`);
const holdRow = (h: { n: number; groups: SpawnGroup[] }) =>
  `n=${h.n}; ${h.groups.map((g) => `${g.command} x${g.count} (mean ${ms(g.meanMs)}, max ${ms(g.maxMs)})`).join("; ") || "-"}`;
const lat = (s: LatencySummary) => `n=${s.n} p50=${ms(s.p50)} p90=${ms(s.p90)} p99=${ms(s.p99)} max=${ms(s.max)} over1s=${s.over1s}`;

function table(title: string, rows: Array<[string, string]>): string {
  return [`### ${title}`, "", "| metric | value |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`), ""].join("\n");
}

export function renderMarkdown(r: BenchReport): string {
  const c = r.context;
  const o = r.observe;
  const parts: string[] = [`## cast bench daemon ${r.startedAt}`, ""];
  parts.push(table("context", [
    ["daemon pid", String(c.daemonPid ?? "none")],
    ["daemon runtime", c.daemonRuntimeVersion ?? "-"],
    ["cli version", c.cliVersion],
    ["heartbeat age", ms(c.heartbeatAgeMs)],
    ["load average", c.loadAvg.join(" / ")],
    ["processes", String(c.processCount)],
    ["tmux sessions", String(c.tmuxSessions)],
    ["free memory", `${c.freeMemMb} MB`],
    ["port", String(c.port)],
    ["/term/sessions auth", c.termAuth],
  ]));
  parts.push(table(`observe (${Math.round(o.durationMs / 1000)}s)`, [
    ["loop lag (/health every 100ms)", lat(o.loopLag.summary)],
    ["loop lag skipped ticks / errors", `${o.loopLag.skipped} / ${o.loopLag.errors}`],
    ["/hook/status", `${lat(o.hookStatus.summary)} statuses=${JSON.stringify(o.hookStatus.statuses)}`],
    ["/term/sessions", o.termSessions ? `${lat(o.termSessions.summary)} statuses=${JSON.stringify(o.termSessions.statuses)}` : `skipped: ${c.termAuth}`],
  ]));
  const f = o.log.freezes;
  parts.push(table(`daemon.log since ${new Date(o.log.sinceMs).toISOString()} (${o.log.linesRead} lines, ${o.log.sleepWindows} sleep windows)`, [
    ["LOOP-FREEZE raw / sleep / freeze", `${f.rawCount} / ${f.sleepCount} / ${f.freezeCount}`],
    ["freeze total / max", `${Math.round(f.totalMs / 1000)}s / ${Math.round(f.maxMs / 1000)}s`],
    ["freeze per hour", f.perHour.map((h) => `${h.hour.slice(5)}: ${h.count} (${Math.round(h.totalMs / 1000)}s, max ${Math.round(h.maxMs / 1000)}s)`).join("; ") || "-"],
    ["top stacks", f.topStacks.map((s) => `${s.key} x${s.count}`).join("; ") || "-"],
    ["top last log", f.topLastLog.map((s) => `${s.key} x${s.count}`).join("; ") || "-"],
    ["PS-SNAPSHOT", `n=${o.log.psSnapshot.n} mean=${ms(o.log.psSnapshot.meanMs)} max=${ms(o.log.psSnapshot.maxMs)}; ${o.log.psSnapshot.buckets.map((b) => `${b.label}: ${b.count}`).join(", ")}`],
    ["SLOW-SYNC-SPAWN", holdRow(o.log.slowSpawn)],
    ["SLOW-SYNC-FS", holdRow(o.log.slowFs)],
    ["boots (blackout)", o.log.boots.map((b) => `${b.startedAt.slice(5, 19)} v${b.version}: ${b.blackoutMs === null ? "no listen line" : `${Math.round(b.blackoutMs / 1000)}s`}`).join("; ") || "-"],
  ]));
  if (r.load) {
    const l = r.load;
    parts.push(table(`load (N=${l.n}, sample=${l.roundTrips.length}, run ${l.runId})`, [
      ["spawned", `${l.spawned}/${l.n}${l.spawnErrors.length ? ` (${l.spawnErrors.length} errors)` : ""}`],
      ["spawn per pane", lat(l.spawnMs)],
      ["mapped to conversations", `${l.mapped}/${l.spawned}`],
      ["mapping time", lat(l.mappingMs)],
      ["churn", `${l.churn.linesAppended} lines over ${Math.round(l.churn.durationMs / 1000)}s`],
      ["loop lag under load", l.loopLag ? `${lat(l.loopLag.summary)} skipped=${l.loopLag.skipped}` : "-"],
      ["/hook/status under load", l.hookStatus ? lat(l.hookStatus.summary) : "-"],
      ["/term/sessions under load", l.termSessions ? lat(l.termSessions.summary) : "-"],
      ["up leg (append to export)", `${lat(l.upMs)} timeouts=${l.roundTrips.filter((t) => t.upMs === null).length}`],
      ["delivery (send to pane)", `${lat(l.injectedMs)} timeouts=${l.roundTrips.filter((t) => t.injectedMs === null).length}`],
      ["echo (send to export)", `${lat(l.echoedMs)} timeouts=${l.roundTrips.filter((t) => t.echoedMs === null).length}`],
      ["teardown", l.teardown.kept ? "kept" : `${l.teardown.conversationsDeleted} conversations deleted${l.teardown.warnings.length ? `; WARN ${l.teardown.warnings.join(" | ")}` : ""}`],
    ]));
  }
  parts.push("Notes:", ...r.notes.map((n) => `- ${n}`), "", `Files: ${r.outputs.json}, ${r.outputs.md}`, "");
  return parts.join("\n");
}
