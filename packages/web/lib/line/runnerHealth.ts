// Whether the machines that stalled a group of runs work again (line-journeys.md
// LJ8.2, Start these again). Runs whose sessions never started, or whose
// runner shut down, failed because of the machine, not the problem: starting
// them again on a machine that still takes no work fails them the same way and
// spends the money anyway. So the review names each machine those runs ran on,
// whether it is online now, and the newest step a session finished there since
// they ended; and it holds the start while none of them has. Pure.
import { dayTimeWords } from "./problemPage";

/** The causes a machine, not the problem, is behind (runReport failCause keys): a session that never started, a
 *  runner that stopped, a run killed at its limit. */
export const isRunnerCause = (key: string): boolean => /^(?:nosession:|runner-|killed)/.test(key);

export type RunnerRun = {
  _id: string;
  runner_device?: string | null;
  /** The account its runner signed in as: whose machine it is. */
  user_id?: string | null;
  updated_at?: number;
  node_statuses?: ReadonlyArray<{ status: string; session_id?: string; completed_at?: number }> | null;
};
/** A machine the viewer can see: theirs (no `owner`), or one their team opened to them, with whose it is. */
export type RunnerDevice = { name: string; online: boolean; owner?: string | null };

export type RunnerMachine = {
  device: string;
  /** Its name in the viewer's roster; null when the roster does not hold it (another account's machine). */
  name: string | null;
  /** Online now; null when the roster does not hold it. */
  online: boolean | null;
  /** Whose it is when not the viewer's: "Aivery's agent box", "Jason's machine"; null for the viewer's own. */
  owner: string | null;
  /** How many of the failed runs ran on it. */
  runs: number;
  /** The newest step a session finished on it after the last of those runs ended; null when none has. */
  workedAt: number | null;
};

/** The machines `failed` ran on, most runs first, each with whether it is online and has worked since. */
export function runnerMachines(failed: ReadonlyArray<RunnerRun>, all: ReadonlyArray<RunnerRun>, devices: ReadonlyMap<string, RunnerDevice>, ownerOf: (userId: string) => string | null = () => null): RunnerMachine[] {
  const ended = new Map<string, { runs: number; at: number; user: string | null }>();
  for (const r of failed) {
    if (!r.runner_device) continue;
    const e = ended.get(r.runner_device) ?? { runs: 0, at: 0, user: null };
    ended.set(r.runner_device, { runs: e.runs + 1, at: Math.max(e.at, r.updated_at ?? 0), user: e.user ?? r.user_id ?? null });
  }
  const failedIds = new Set(failed.map((r) => r._id));
  return [...ended].map(([device, e]) => {
    let workedAt: number | null = null;
    for (const r of all) {
      if (r.runner_device !== device || failedIds.has(r._id)) continue;
      for (const n of r.node_statuses ?? []) {
        if (n.status === "completed" && n.session_id && (n.completed_at ?? 0) > e.at && (n.completed_at ?? 0) > (workedAt ?? 0)) workedAt = n.completed_at!;
      }
    }
    const d = devices.get(device);
    // A machine nobody opened to the viewer is still named by whose account its runner signed in as.
    const owner = d ? d.owner ?? null : e.user ? ownerOf(e.user) : null;
    return { device, name: d?.name ?? null, online: d ? d.online : null, owner, runs: e.runs, workedAt };
  }).sort((a, b) => b.runs - a.runs || a.device.localeCompare(b.device));
}

/** Why the start waits, when a machine caused the failures and its stall is not cleared; null when it is, or the cause
 *  is the problem's own. A new run goes to the runner's queue, which any of its machines may take, so one machine that
 *  is up but has finished no step since these stalled would take the new runs and stall them the same way, whatever
 *  another machine does: the start waits on that one. With every machine offline, nothing would take them at all. */
export function runnerHold(key: string, machines: ReadonlyArray<RunnerMachine>): string | null {
  if (!isRunnerCause(key) || !machines.length) return null;
  const names = (ms: ReadonlyArray<RunnerMachine>) => {
    const n = ms.map((m) => m.name ?? m.device.slice(0, 6));
    return { them: n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`, one: n.length === 1 };
  };
  const stuck = machines.filter((m) => m.online !== false && m.workedAt == null);
  if (stuck.length) return `No session has finished a step on ${names(stuck).them} since these stalled`;
  if (machines.every((m) => m.online === false)) { const n = names(machines); return `${n.them} ${n.one ? "is" : "are"} offline`; }
  return null;
}

/** The machine rows and the hold, laid onto a Start these again review when a machine caused the failures: each
 *  machine as a fact ("Online · finished a step Oct 13, 9:10 AM"), and the start held while none of them works. */
export function withRunners<L extends { rows: ReadonlyArray<{ k: string; v: string; tone?: "ok" | "warn"; act?: { label: string; press: () => void } }>; alert?: string; blocked?: string }>(ledger: L, key: string, machines: ReadonlyArray<RunnerMachine>, openMachines?: () => void): L {
  if (!isRunnerCause(key) || !machines.length) return ledger;
  const rows = machines.map((m) => { const works = m.online !== false && m.workedAt != null; return {
    k: m.name ?? `Machine ${m.device.slice(0, 6)}`,
    v: [
      m.owner,
      m.online == null ? "not shared with you" : m.online ? "Online" : "Offline",
      m.workedAt != null ? `finished a step ${dayTimeWords(m.workedAt)}` : "no step finished since these stalled",
    ].filter(Boolean).join(" · "),
    ...(works ? {} : { tone: "warn" as const }),
    // Where the machine is kept (the viewer's own and their team's, with removing and sharing), for one that is not
    // the viewer's or does not work: a working machine of their own needs nothing done.
    ...(openMachines && (m.owner || m.online == null || !works) ? { act: { label: "Machines…", press: openMachines } } : {}),
  }; });
  const hold = runnerHold(key, machines);
  const [where, ...rest] = ledger.rows;
  return { ...ledger, rows: where ? [where, ...rows, ...rest] : rows, ...(hold ? { alert: hold, blocked: hold } : {}) };
}
