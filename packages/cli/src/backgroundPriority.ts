// Sessions a person put at background priority from the resource sheet.
//
// Work that cannot leave the machine (a render over a local footage library)
// still need not compete with everything interactive. At background priority
// macOS runs a process on the efficiency cores and gives way to anything else;
// on Linux it is niced. The set of sessions comes back from the server with
// every resource report, and each tick applies it to every process the session
// owns, so the renders it starts later inherit nothing and are caught anyway.
import { execFileAsync } from "./proc.js";
import type { ResourceProcess } from "@codecast/shared/contracts";
import { sameStartedAt } from "./resourceMonitor.js";

export type SetPriority = (pid: number, background: boolean) => Promise<boolean>;

const setPriority: SetPriority = async (pid, background) => {
  const [cmd, args] = process.platform === "darwin"
    ? ["taskpolicy", [background ? "-b" : "-B", "-p", String(pid)]]
    : ["renice", ["-n", background ? "10" : "0", "-p", String(pid)]];
  try {
    await execFileAsync(cmd, args, { timeout: 2000, killSignal: "SIGKILL" });
    return true;
  } catch {
    return false;
  }
};

const wanted = new Set<string>();
/** Processes this daemon put at background priority: pid to the start time it had. */
const applied = new Map<number, number | undefined>();
let lastSeen: ResourceProcess[] = [];
const isApplied = (p: Pick<ResourceProcess, "pid" | "startedAt">) => applied.has(p.pid) && sameStartedAt(applied.get(p.pid), p.startedAt);

async function reconcile(processes: ResourceProcess[], run: SetPriority): Promise<void> {
  const live = new Map(processes.map((p) => [p.pid, p]));
  for (const [pid] of applied) {
    const p = live.get(pid);
    if (!p || !isApplied(p)) applied.delete(pid);
    else if (!p.sessionId || !wanted.has(p.sessionId)) {
      await run(pid, false);
      applied.delete(pid);
    }
  }
  for (const p of processes) {
    if (!p.sessionId || !wanted.has(p.sessionId) || isApplied(p)) continue;
    if (await run(p.pid, true)) applied.set(p.pid, p.startedAt);
  }
}

/** Applies the wanted set to this tick's processes and marks the ones running at background priority. */
export async function applyBackground(processes: ResourceProcess[], run: SetPriority = setPriority): Promise<ResourceProcess[]> {
  lastSeen = processes;
  await reconcile(processes, run);
  return processes.map((p) => (isApplied(p) ? { ...p, background: true as const } : p));
}

/** The server's answer to a report: applied at once to the processes last seen, so a press takes effect within a report. */
export async function setBackgroundSessions(ids: readonly string[], run: SetPriority = setPriority): Promise<void> {
  const next = new Set(ids);
  if (next.size === wanted.size && [...next].every((id) => wanted.has(id))) return;
  wanted.clear();
  for (const id of next) wanted.add(id);
  await reconcile(lastSeen, run);
}

export function resetBackgroundForTest(): void {
  wanted.clear();
  applied.clear();
  lastSeen = [];
}
