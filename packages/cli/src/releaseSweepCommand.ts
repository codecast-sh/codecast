// `cast release sweep`: what the workspace's Release Captain must act on now
// (convex releaseSweep.ts), one line per exception with the id to act on and
// the command that acts. Precheck semantics, so it gates the captain's hourly
// check: exit 0 when anything needs action, 1 when the hour is quiet, 2 when
// the sweep itself failed (never read as quiet). `--keys` prints what a
// `changes` precheck compares, so the check wakes on a new exception only.

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroupLookup.js";

export const SWEEP_FOUND_EXIT = 0;
export const SWEEP_QUIET_EXIT = 1;
export const SWEEP_ERROR_EXIT = 2;

type Run = { task_short_id: string | null; station: string | null };
export type Sweep = {
  incidents: Array<{ short_id: string; title: string; runs: Run[] }>;
  late_targets: Array<{ target: string; repository: string; commits: number; oldest_sha: string; waiting_since: number; deadline_ms: number; open: { short_id: string; status: string } | null }>;
  failed_runs: Array<{ task_short_id: string; flow: string; station: string; reason: string | null; failed_at: number }>;
  laggards: Array<{ device_id: string; label: string; owner: string; own: boolean; cli_version: string | null; floor: string; floor_set_at: number | null }>;
  unretired: Array<{ short_id: string; title: string | null }>;
};

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const oneLine = (s: string, max = 120) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

export const sweepCount = (s: Sweep) => s.incidents.length + s.late_targets.length + s.failed_runs.length + s.laggards.length + s.unretired.length;

/** One line per exception: what it is, then the command that acts on it. */
export function formatSweep(s: Sweep, now: number): string[] {
  const lines: string[] = [];
  for (const i of s.incidents) {
    const runs = i.runs.map((r) => `${r.task_short_id ?? "a run"}${r.station ? ` at ${r.station}` : ""}`).join(", ");
    lines.push(`${i.short_id}  incident: ${oneLine(i.title)}; holds ${i.runs.length} run${i.runs.length === 1 ? "" : "s"} (${runs})  fix the cause, then: cast task done ${i.short_id} (its runs resume)`);
  }
  for (const t of s.late_targets) {
    const act = t.open ? `${t.open.short_id} is ${t.open.status}: cast line deploy show ${t.open.short_id}` : `send: cast line deploy --target ${t.target} --go (in a checkout of ${t.repository})`;
    lines.push(`${t.target}  ${t.commits} commit${t.commits === 1 ? "" : "s"} not live ${span(now - t.waiting_since)} after merging (deadline ${span(t.deadline_ms)}), oldest ${t.oldest_sha.slice(0, 10)}  ${act}`);
  }
  for (const r of s.failed_runs) {
    lines.push(`${r.task_short_id}  ${r.flow} run failed at ${r.station} ${span(now - r.failed_at)} ago${r.reason ? `: ${oneLine(r.reason)}` : ""}  resume once fixed: cast workflow resume ${r.task_short_id} --at ${r.station}`);
  }
  for (const l of s.laggards) {
    const since = l.floor_set_at ? ` for ${span(now - l.floor_set_at)}` : "";
    lines.push(`${l.label}  ${l.owner}'s machine runs ${l.cli_version ?? "an unknown version"}, below the floor ${l.floor}${since}  ${l.own ? `update: cast devices update ${l.label}` : `ask ${l.owner} to run: cast devices update ${l.label}`}`);
  }
  for (const u of s.unretired) {
    lines.push(`${u.short_id}  live everywhere and settled, not retired${u.title ? `: ${oneLine(u.title, 80)}` : ""}  retire: cast kill ${u.short_id}`);
  }
  return lines;
}

/**
 * One stable key per exception, sorted: what it is and its id, never a time
 * relative to now, so a `changes` precheck wakes the captain only when the set
 * of exceptions changes, not every hour one it cannot clear still stands. A
 * failed run carries its failure time and a laggard the floor it is below, so
 * the same run failing again or a new floor reads as new.
 */
export function sweepKeys(s: Sweep): string[] {
  return [
    ...s.incidents.map((i) => `incident ${i.short_id}`),
    ...s.late_targets.map((t) => `late ${t.target} ${t.oldest_sha.slice(0, 10)}`),
    ...s.failed_runs.map((r) => `failed ${r.task_short_id} ${r.station} ${r.failed_at}`),
    ...s.laggards.map((l) => `lagging ${l.device_id} below ${l.floor}`),
    ...s.unretired.map((u) => `unretired ${u.short_id}`),
  ].sort();
}

/** Read the sweep and print it; the exit code (precheck semantics). `read` throws on any failure. */
export async function runSweep(o: { read: () => Promise<Sweep>; json?: boolean; keys?: boolean; quiet?: boolean; log: (line: string) => void; error: (line: string) => void; now?: () => number }): Promise<number> {
  let s: Sweep;
  try {
    s = await o.read();
  } catch (err) {
    if (!o.quiet) o.error(`release sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return SWEEP_ERROR_EXIT;
  }
  const code = sweepCount(s) ? SWEEP_FOUND_EXIT : SWEEP_QUIET_EXIT;
  if (o.quiet) return code;
  if (o.keys) for (const key of sweepKeys(s)) o.log(key);
  else if (o.json) o.log(JSON.stringify(s, null, 2));
  else if (code === SWEEP_QUIET_EXIT) o.log("Nothing needs the Release Captain: no open incident, late target, failed run, lagging machine or unretired session.");
  else for (const line of formatSweep(s, (o.now ?? Date.now)())) o.log(line);
  return code;
}

export function registerReleaseCommand(program: Command, deps: PublishDeps): void {
  const release = program.command("release").description(commandGroup("release").description);
  release.command("sweep")
    .description("What the Release Captain must act on now: open incidents, targets past their deadline, failed runs outside an incident, machines below the floor, live sessions not retired. Exits 0 when something needs action, 1 when quiet, 2 on error (a precheck)")
    .option("--team <name|id>", "The workspace (default: your active team)")
    .option("--json", "Machine-readable output")
    .option("--keys", "Print one stable key per exception (kind and id, no times), sorted: the gate for a changes precheck")
    .option("--quiet", "Print nothing; the exit code alone answers")
    .addHelpText("after", `
Gate the Release Captain's hourly check on new exceptions, not on standing ones
(a teammate's machine below the floor, an incident whose fix is in flight would
otherwise wake it every hour): give its check this precheck, read in changes mode.
  cast role tune @release --team <id> --precheck "cast release sweep --keys --team <id>" --why "Wake on new exceptions only"
  cast trigger update <the check's tr-N> --precheck-mode changes
It then wakes only when the set of keys differs from the last firing's. The first
firing records the keys and skips; a quiet hour (exit 1) or an error (exit 2)
skips and keeps the record. cast trigger log <tr-N> shows why a firing skipped.`)
    .action(async (opts: { team?: string; json?: boolean; keys?: boolean; quiet?: boolean }) => {
      const read = async () => {
        const { loadWorkspaceRoster, resolveWorkspaceForRead, workspaceScope } = await import("./resolveWorkspace.js");
        // Every failure throws, so it reads as an error (2), never as a quiet hour (1).
        const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true, exitOnError: false }));
        return await apiPost(deps, "/cli/release/sweep", workspaceScope(resolveWorkspaceForRead(roster, opts.team)), { read: true, exitOnError: false }) as Sweep;
      };
      process.exit(await runSweep({ read, json: opts.json, keys: opts.keys, quiet: opts.quiet, log: (l) => console.log(l), error: (l) => console.error(l) }));
    });
}
