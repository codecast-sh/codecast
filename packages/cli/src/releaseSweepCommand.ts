// `cast release sweep`: what the workspace's Release Captain must act on now
// (convex releaseSweep.ts), one line per exception with the id to act on and
// the command that acts. Precheck semantics, so it gates the captain's hourly
// check: exit 0 when anything needs action, 1 when the hour is quiet, 2 when
// the sweep itself failed (never read as quiet). `--new` is the gate for a
// `state` precheck: it wakes the check on an exception not seen in a week,
// never on one that only went away, nor on one that comes back within it.

import type { Command } from "commander";
import { TRIGGER_PRECHECK_MESSAGE_CHARS, TRIGGER_PRECHECK_STATE_CHARS, TRIGGER_PRECHECK_STATE_ENV } from "@codecast/shared/contracts";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroupLookup.js";

export const SWEEP_FOUND_EXIT = 0;
export const SWEEP_QUIET_EXIT = 1;
export const SWEEP_ERROR_EXIT = 2;

// Everything printed here reaches @release as its input (a `--new` firing's message), so it holds only ids, counts,
// shas, versions, times, states and the commands that act, as the server sends them (convex releaseSweep.ts). Free
// text other people write (titles, stop reasons, device labels, names) never does: `project` keeps only these fields,
// whatever a server answers, and each line points at the command that shows the rest.
type Run = { task_short_id: string | null; station: string | null };
export type Sweep = {
  incidents: Array<{ short_id: string; status: string; runs: Run[] }>;
  late_targets: Array<{ target: string; repository: string; commits: number; oldest_sha: string; waiting_since: number; deadline_ms: number; open: { short_id: string; status: string } | null }>;
  failed_runs: Array<{ task_short_id: string; flow: string; station: string | null; failed_at: number }>;
  laggards: Array<{ device: string; device_id: string | null; own: boolean; owner_id: string; cli_version: string | null; floor: string; floor_set_at: number | null }>;
  unretired: Array<{ short_id: string }>;
  /** The kinds the server could not read this time, each listed empty (absent from an older server). */
  failed_kinds?: SweepKind[];
  /** Sessions the server could not judge for retirement this time, left out of `unretired` (absent from an older server). */
  unretired_skipped?: number;
};

const SWEEP_KINDS = ["incidents", "late_targets", "failed_runs", "laggards", "unretired"] as const;
type SweepKind = (typeof SWEEP_KINDS)[number];

/** The sweep's own fields and nothing else a server sent. */
export function project(s: Sweep): Sweep {
  return {
    incidents: s.incidents.map((i) => ({ short_id: i.short_id, status: i.status, runs: (i.runs ?? []).map((r) => ({ task_short_id: r.task_short_id, station: r.station })) })),
    late_targets: s.late_targets.map((t) => ({ target: t.target, repository: t.repository, commits: t.commits, oldest_sha: t.oldest_sha, waiting_since: t.waiting_since, deadline_ms: t.deadline_ms, open: t.open ? { short_id: t.open.short_id, status: t.open.status } : null })),
    failed_runs: s.failed_runs.map((r) => ({ task_short_id: r.task_short_id, flow: r.flow, station: r.station, failed_at: r.failed_at })),
    laggards: s.laggards.map((l) => ({ device: l.device, device_id: l.device_id, own: l.own, owner_id: l.owner_id, cli_version: l.cli_version, floor: l.floor, floor_set_at: l.floor_set_at })),
    unretired: s.unretired.map((u) => ({ short_id: u.short_id })),
    // Only the kind names this CLI knows: anything else a server sent is dropped.
    ...(Array.isArray(s.failed_kinds) && s.failed_kinds.length ? { failed_kinds: SWEEP_KINDS.filter((k) => s.failed_kinds!.includes(k)) } : {}),
    ...(Number.isInteger(s.unretired_skipped) && s.unretired_skipped! > 0 ? { unretired_skipped: s.unretired_skipped } : {}),
  };
}

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export const sweepCount = (s: Sweep) => s.incidents.length + s.late_targets.length + s.failed_runs.length + s.laggards.length + s.unretired.length;

/** A body the server answered with: every list there, or the read failed (an empty 200 is no quiet hour). */
const isSweep = (s: unknown): s is Sweep =>
  !!s && typeof s === "object" && SWEEP_KINDS.every((k) => Array.isArray((s as any)[k]));

/** One line per exception: what it is, then the command that acts on it. */
export function formatSweep(s: Sweep, now: number): string[] {
  const lines: string[] = [];
  for (const i of s.incidents) {
    const runs = i.runs.map((r) => `${r.task_short_id ?? "a run"}${r.station ? ` at ${r.station}` : ""}`).join(", ");
    lines.push(`${i.short_id}  incident holding ${i.runs.length} run${i.runs.length === 1 ? "" : "s"} (${runs})  what broke: cast task show ${i.short_id}; fix the cause, then: cast task done ${i.short_id} (its runs resume)`);
  }
  for (const t of s.late_targets) {
    const act = t.open ? `${t.open.short_id} is ${t.open.status}: cast line deploy show ${t.open.short_id}` : `send: cast line deploy --target ${t.target} --go (in a checkout of ${t.repository})`;
    lines.push(`${t.target}  ${t.commits} commit${t.commits === 1 ? "" : "s"} not live ${span(now - t.waiting_since)} after merging (deadline ${span(t.deadline_ms)}), oldest ${t.oldest_sha.slice(0, 10)}  ${act}`);
  }
  for (const r of s.failed_runs) {
    const resume = r.station ? `resume once fixed: cast workflow resume ${r.task_short_id} --at ${r.station}` : `resume once fixed: cast workflow resume ${r.task_short_id}`;
    lines.push(`${r.task_short_id}  ${r.flow} run failed${r.station ? ` at ${r.station}` : ""} ${span(now - r.failed_at)} ago  why: cast task show ${r.task_short_id}; ${resume}`);
  }
  for (const l of s.laggards) {
    const since = l.floor_set_at ? ` for ${span(now - l.floor_set_at)}` : "";
    const update = l.device_id ? `cast devices update ${l.device_id}` : "cast devices update <it> (cast devices lists it)";
    lines.push(`${l.device_id ?? l.device}  ${l.own ? "your" : "a teammate's"} machine runs ${l.cli_version ?? "an unknown version"}, below the floor ${l.floor}${since}  ${l.own ? `update: ${update}` : `ask its owner to run: ${update}`}`);
  }
  for (const u of s.unretired) {
    lines.push(`${u.short_id}  live everywhere and settled, not retired  retire: cast kill ${u.short_id}`);
  }
  return lines;
}

/**
 * One stable key per exception, sorted: what it is and its id, never a time
 * relative to now, so the same exception reads the same every hour. A failed
 * run carries its failure time and a laggard the floor it is below, so the
 * same run failing again or a new floor reads as new.
 */
export function sweepKeys(s: Sweep): string[] {
  return [
    ...s.incidents.map((i) => `incident ${i.short_id}`),
    ...s.late_targets.map((t) => `late ${t.target} ${t.oldest_sha.slice(0, 10)}`),
    ...s.failed_runs.map((r) => `failed ${r.task_short_id} ${r.station} ${r.failed_at}`),
    ...s.laggards.map((l) => `lagging ${l.device} below ${l.floor}`),
    ...s.unretired.map((u) => `unretired ${u.short_id}`),
  ].sort();
}

/**
 * How long a key stays seen after the sweep last listed it. An exception that
 * leaves the sweep and comes back within it (failed runs age out of their 2h
 * window, a laggard laptop sleeps and wakes) is not new; one gone longer is.
 */
export const SEEN_KEY_MS = 7 * 24 * 60 * 60_000;

/** A `state` precheck's state: each key seen in the last SEEN_KEY_MS, with when it was first and last seen. */
export type SweepSeen = { seen: Record<string, [first: number, last: number]> };

/**
 * The `--new` verdict for a state precheck (contracts/triggerPrecheck.ts):
 * wake iff the sweep lists a key the previous state has not seen within
 * SEEN_KEY_MS. A set that only shrank, or standing exceptions, never wake. The
 * state keeps the keys seen within the window, and is cut to fit the state the
 * trigger keeps, dropping the keys the sweep no longer lists, longest gone first.
 */
export function sweepVerdict(s: Sweep, previous: unknown, now: number): { wake: boolean; state: SweepSeen; message: string } {
  const prior = previous && typeof previous === "object" && (previous as any).seen && typeof (previous as any).seen === "object" ? (previous as SweepSeen).seen : {};
  const seen: SweepSeen["seen"] = {};
  for (const [key, at] of Object.entries(prior)) {
    if (Array.isArray(at) && typeof at[0] === "number" && typeof at[1] === "number" && now - at[1] <= SEEN_KEY_MS) seen[key] = [at[0], at[1]];
  }
  const keys = sweepKeys(s);
  const fresh = keys.filter((k) => !(k in seen));
  for (const k of keys) seen[k] = [seen[k]?.[0] ?? now, now];
  const full = fresh.length ? [`New: ${fresh.join("; ")}`, ...formatSweep(s, now)].join("\n") : keys.length ? `no new exception; ${keys.length} standing` : "nothing needs the Release Captain";
  const message = full.length > TRIGGER_PRECHECK_MESSAGE_CHARS ? `${full.slice(0, TRIGGER_PRECHECK_MESSAGE_CHARS - 1)}…` : full;
  const verdict = { wake: fresh.length > 0, state: { seen }, message };
  // Its whole stdout must fit what a state precheck reads, or the verdict is refused and no firing ever wakes: drop
  // the keys the sweep no longer lists, longest gone first, then (a pathological sweep) standing ones, which then
  // read as new on a later firing.
  const drop = Object.keys(seen).sort((a, b) => seen[a][1] - seen[b][1] || seen[a][0] - seen[b][0]);
  while (JSON.stringify(verdict).length >= TRIGGER_PRECHECK_STATE_CHARS && drop.length) delete seen[drop.shift()!];
  return verdict;
}

/** Read the sweep and print it; the exit code (precheck semantics). `read` throws on any failure. With `newSince`
 *  (the state precheck's previous state, as JSON), it prints sweepVerdict's JSON and exits 0, or 2 on a failed read.
 *  `newSince: null` is `--new` outside a state precheck (no state variable): 2, never a verdict an exit-mode precheck
 *  would read as "wake" every firing. */
export async function runSweep(o: { read: () => Promise<Sweep>; json?: boolean; newSince?: string | null; quiet?: boolean; log: (line: string) => void; error: (line: string) => void; now?: () => number }): Promise<number> {
  if (o.newSince === null) {
    o.error(`--new needs a state-mode precheck: cast trigger update <tr> --precheck-mode state`);
    return SWEEP_ERROR_EXIT;
  }
  let s: Sweep;
  let previous: unknown = null;
  // A state it cannot read starts the seen set over, rather than skipping every firing from then on.
  try { previous = JSON.parse(o.newSince || "null"); } catch {}
  try {
    const read: unknown = await o.read();
    if (!isSweep(read)) throw new Error("the server answered with no sweep");
    s = project(read);
  } catch (err) {
    if (!o.quiet) o.error(`release sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return SWEEP_ERROR_EXIT;
  }
  // A kind the server could not read is listed empty and named; only every kind failing is a failed read.
  const failedKinds = s.failed_kinds ?? [];
  if (failedKinds.length === SWEEP_KINDS.length) {
    if (!o.quiet) o.error(`release sweep failed: no kind could be read (${failedKinds.join(", ")})`);
    return SWEEP_ERROR_EXIT;
  }
  if (failedKinds.length && !o.quiet) o.error(`release sweep could not read ${failedKinds.join(", ")} this time; listed as empty`);
  if (s.unretired_skipped && !o.quiet) o.error(`release sweep could not judge ${s.unretired_skipped} session${s.unretired_skipped === 1 ? "" : "s"} for retirement this time; left out of unretired`);
  if (o.newSince !== undefined) {
    o.log(JSON.stringify(sweepVerdict(s, previous, (o.now ?? Date.now)())));
    return SWEEP_FOUND_EXIT;
  }
  const code = sweepCount(s) ? SWEEP_FOUND_EXIT : SWEEP_QUIET_EXIT;
  if (o.quiet) return code;
  if (o.json) o.log(JSON.stringify(s, null, 2));
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
    .option("--new", `The gate for a state precheck: reads the keys it saw from $${TRIGGER_PRECHECK_STATE_ENV}, prints {"wake", "state", "message"}, and wakes only on an exception not seen in 7 days`)
    .option("--quiet", "Print nothing; the exit code alone answers")
    .addHelpText("after", `
Gate the Release Captain's hourly check on new exceptions, not on standing ones
(a teammate's machine below the floor, an incident whose fix is in flight) nor on
ones that only went away or came back (a failed run aging out of the sweep, a
laggard laptop asleep for a night): give its check this precheck, read in state mode.
  cast role tune @release --team <id> --precheck "cast release sweep --new --team <id>" --why "Wake on new exceptions only"
  cast trigger update <the check's tr-N> --precheck-mode state
Each firing it keeps one key per exception (kind and id, sorted, no times) with
when it was first and last listed, and drops a key 7 days after it was last
listed. It wakes only when the sweep lists a key not kept, and hands the run the
new keys and the whole sweep. The first firing has kept nothing, so it wakes on
what stands then. An error (exit 2) skips and keeps the state. cast trigger log
<tr-N> shows why a firing skipped.`)
    .action(async (opts: { team?: string; json?: boolean; new?: boolean; quiet?: boolean }) => {
      const read = async () => {
        const { loadWorkspaceRoster, resolveWorkspaceForRead, workspaceScope } = await import("./resolveWorkspace.js");
        // Every failure throws, so it reads as an error (2), never as a quiet hour (1).
        const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true, exitOnError: false }));
        return await apiPost(deps, "/cli/release/sweep", workspaceScope(resolveWorkspaceForRead(roster, opts.team)), { read: true, exitOnError: false }) as Sweep;
      };
      // A state precheck always sets the variable ("null" on its first firing); unset, this is no state precheck.
      const newSince = opts.new ? (process.env[TRIGGER_PRECHECK_STATE_ENV] ?? null) : undefined;
      process.exit(await runSweep({ read, json: opts.json, newSince, quiet: opts.quiet, log: (l) => console.log(l), error: (l) => console.error(l) }));
    });
}
