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
  updated_at?: number;
  node_statuses?: ReadonlyArray<{ status: string; session_id?: string; completed_at?: number }> | null;
};
export type RunnerDevice = { name: string; online: boolean };

export type RunnerMachine = {
  device: string;
  /** Its name in the viewer's roster; null when the roster does not hold it (another account's machine). */
  name: string | null;
  /** Online now; null when the roster does not hold it. */
  online: boolean | null;
  /** How many of the failed runs ran on it. */
  runs: number;
  /** The newest step a session finished on it after the last of those runs ended; null when none has. */
  workedAt: number | null;
};

/** The machines `failed` ran on, most runs first, each with whether it is online and has worked since. */
export function runnerMachines(failed: ReadonlyArray<RunnerRun>, all: ReadonlyArray<RunnerRun>, devices: ReadonlyMap<string, RunnerDevice>): RunnerMachine[] {
  const ended = new Map<string, { runs: number; at: number }>();
  for (const r of failed) {
    if (!r.runner_device) continue;
    const e = ended.get(r.runner_device) ?? { runs: 0, at: 0 };
    ended.set(r.runner_device, { runs: e.runs + 1, at: Math.max(e.at, r.updated_at ?? 0) });
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
    return { device, name: d?.name ?? null, online: d ? d.online : null, runs: e.runs, workedAt };
  }).sort((a, b) => b.runs - a.runs || a.device.localeCompare(b.device));
}

/** Why the start waits, when a machine caused the failures and none of the machines that stalled them has worked since;
 *  null when one has, or the cause is the problem's own. */
export function runnerHold(key: string, machines: ReadonlyArray<RunnerMachine>): string | null {
  if (!isRunnerCause(key) || !machines.length || machines.some((m) => m.online !== false && m.workedAt != null)) return null;
  const names = machines.map((m) => m.name ?? m.device.slice(0, 6));
  const them = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return machines.every((m) => m.online === false)
    ? `${them} ${names.length === 1 ? "is" : "are"} offline`
    : `No session has finished a step on ${them} since these stalled`;
}

/** The machine rows and the hold, laid onto a Start these again review when a machine caused the failures: each
 *  machine as a fact ("Online · finished a step Oct 13, 9:10 AM"), and the start held while none of them works. */
export function withRunners<L extends { rows: ReadonlyArray<{ k: string; v: string; tone?: "ok" | "warn" }>; alert?: string; blocked?: string }>(ledger: L, key: string, machines: ReadonlyArray<RunnerMachine>): L {
  if (!isRunnerCause(key) || !machines.length) return ledger;
  const rows = machines.map((m) => ({
    k: m.name ?? `Machine ${m.device.slice(0, 6)}`,
    v: `${m.online == null ? "Not in your machines" : m.online ? "Online" : "Offline"} · ${m.workedAt != null ? `finished a step ${dayTimeWords(m.workedAt)}` : "no step finished since these stalled"}`,
    ...(m.online !== false && m.workedAt != null ? {} : { tone: "warn" as const }),
  }));
  const hold = runnerHold(key, machines);
  const [where, ...rest] = ledger.rows;
  return { ...ledger, rows: where ? [where, ...rows, ...rest] : rows, ...(hold ? { alert: hold, blocked: hold } : {}) };
}
