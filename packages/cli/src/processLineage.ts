// Which processes each live process descended from, remembered after the
// parent links are gone.
//
// A teardown walks the process table by parent pid at kill time, so anything
// reparented to launchd before the kill is invisible to it. The case that
// matters: an agent's tool shells run in sessions of their own, and when the
// agent exits (a restart, a crash, a resume in the same pane) they reparent to
// pid 1 and keep running for hours. Their environment cannot be read on macOS,
// so the only evidence of who started them is the tree they were seen in while
// their parent lived. The daemon's resource tick feeds every snapshot here, and
// a teardown asks which survivors once sat under a process it is killing.
//
// Ancestry never crosses a detach that a non-agent made. A process that leads
// its own group with no controlling terminal started a session of its own
// (setsid, `detached: true`): that is how every shared service starts (the
// tsc watchers, the browser bridge, `cast dev` servers, the daemon itself),
// and those outlive the session that happened to launch them on purpose. The
// one detach followed is the agent's own: its tool shells are its work.
import { AGENT_START_JITTER_MS, type ProcessInfo } from "./resourceMonitor.js";
import type { ProcRow } from "./processTable.js";

type Lineage = { startedAt: number; ancestors: Map<number, number> };

/** A process that started a session of its own, away from `parent`. Unknown
 *  group or terminal counts as detached: without proof, ancestry stops. */
export function detachedFrom(child: ProcessInfo, parent: ProcessInfo): boolean {
  if (child.pgid === undefined || parent.pgid === undefined || child.tty === undefined) return true;
  return child.pgid === child.pid && child.pgid !== parent.pgid && /^(\?\??|-)$/.test(child.tty);
}

const sameStart = (a: number, b: number) => Math.abs(a - b) <= AGENT_START_JITTER_MS;

export class ProcessLineage {
  private entries = new Map<number, Lineage>();

  /** Fold one snapshot in: every live process keeps the ancestors it was ever
   *  seen under, and a process that has exited is forgotten. */
  observe(snapshot: Map<number, ProcessInfo>, isAgent: (p: ProcessInfo) => boolean): void {
    const next = new Map<number, Lineage>();
    for (const p of snapshot.values()) {
      if (p.pid <= 1 || p.startedAt === undefined) continue;
      const prev = this.entries.get(p.pid);
      const kept = prev && sameStart(prev.startedAt, p.startedAt) ? prev : undefined;
      const ancestors = new Map(kept?.ancestors);
      let child = p;
      for (let hops = 0; hops < 64; hops++) {
        const parent = snapshot.get(child.ppid);
        if (!parent || parent.pid <= 1 || parent.startedAt === undefined) break;
        if (detachedFrom(child, parent) && !isAgent(parent)) break;
        ancestors.set(parent.pid, parent.startedAt);
        child = parent;
      }
      if (ancestors.size) next.set(p.pid, { startedAt: kept?.startedAt ?? p.startedAt, ancestors });
    }
    this.entries = next;
  }

  /** Was `row` ever seen under one of `tree`'s processes? Both sides are
   *  matched on pid and start time, so a recycled pid is no one's. */
  descendsFrom(row: ProcRow, tree: ReadonlyMap<number, ProcRow>): boolean {
    const entry = this.entries.get(row.pid);
    const started = row.startedAt ? Date.parse(row.startedAt) : NaN;
    if (!entry || !Number.isFinite(started) || !sameStart(entry.startedAt, started)) return false;
    for (const [pid, ancestorStart] of entry.ancestors) {
      const t = tree.get(pid)?.startedAt;
      const tStart = t ? Date.parse(t) : NaN;
      if (Number.isFinite(tStart) && sameStart(tStart, ancestorStart)) return true;
    }
    return false;
  }

  get size(): number {
    return this.entries.size;
  }
}
