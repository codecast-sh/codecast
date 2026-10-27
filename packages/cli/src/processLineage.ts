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
//
// A process group is remembered the same way, because a group keeps its id
// after its leader exits and every process born into it later inherits it. A
// background tool shell running `npm run dev` is seen under the agent; the
// server npm forks after that sample, and that outlives the shell, never is.
// Its group still names the shell. The entry lives only while some member is
// seen on every sample, so the id cannot have been handed out again unseen.
//
// The daemon writes all of it to disk on every tick and reads it at boot, so
// a restart does not forget whose orphans are whose. Every use matches pids on
// start time, so an entry that went stale while the daemon was down is no
// one's.
import * as fs from "node:fs";
import { noTerminal } from "./psTerminal.js";
import { sameStartedAt, type ProcessInfo } from "./resourceMonitor.js";
import type { ProcRow } from "./processTable.js";

type Ancestors = Map<number, number>;
type Lineage = { startedAt: number; ancestors: Ancestors };

/** A process that started a session of its own, away from `parent`. Unknown
 *  group or terminal counts as detached: without proof, ancestry stops. */
export function detachedFrom(child: ProcessInfo, parent: ProcessInfo): boolean {
  if (child.pgid === undefined || parent.pgid === undefined || child.tty === undefined) return true;
  return child.pgid === child.pid && child.pgid !== parent.pgid && noTerminal(child.tty);
}

const sameStart = (a: number, b: number) => sameStartedAt(a, b);

const touchesTree = (ancestors: Ancestors, tree: ReadonlyMap<number, ProcRow>): boolean => {
  for (const [pid, ancestorStart] of ancestors) {
    const t = tree.get(pid)?.startedAt;
    const tStart = t ? Date.parse(t) : NaN;
    if (Number.isFinite(tStart) && sameStart(tStart, ancestorStart)) return true;
  }
  return false;
};

export class ProcessLineage {
  private entries = new Map<number, Lineage>();
  /** Process group id to the ancestors any member was seen under. */
  private groups = new Map<number, Ancestors>();

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
    const groups = new Map<number, Ancestors>();
    for (const p of snapshot.values()) {
      if (p.pgid === undefined || p.pgid <= 1) continue;
      const own = next.get(p.pid)?.ancestors;
      const prev = this.groups.get(p.pgid);
      if (!own && !prev) continue;
      const merged = groups.get(p.pgid) ?? new Map(prev);
      for (const [pid, start] of own ?? []) merged.set(pid, start);
      groups.set(p.pgid, merged);
    }
    this.entries = next;
    this.groups = groups;
  }

  /** Was `row`, or a group it belongs to, ever seen under one of `tree`'s
   *  processes? Both sides are matched on pid and start time, so a recycled
   *  pid is no one's. A group answers only while its id names no live process
   *  in `table`: a live leader is judged as itself, and a live pid that is not
   *  the group's leader means the group emptied and the id was reused. */
  descendsFrom(row: ProcRow, tree: ReadonlyMap<number, ProcRow>, table?: ReadonlyMap<number, ProcRow | null>): boolean {
    const entry = this.entries.get(row.pid);
    const started = row.startedAt ? Date.parse(row.startedAt) : NaN;
    if (entry && Number.isFinite(started) && sameStart(entry.startedAt, started) && touchesTree(entry.ancestors, tree)) return true;
    const group = row.pgid !== undefined && row.pgid !== row.pid ? this.groups.get(row.pgid) : undefined;
    return !!group && !!table && !table.has(row.pgid!) && touchesTree(group, tree);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Written whole, then renamed into place, so a reader never sees half. */
  async save(file: string): Promise<void> {
    const pairs = (m: Ancestors) => [...m];
    const data = {
      entries: [...this.entries].map(([pid, e]) => [pid, e.startedAt, pairs(e.ancestors)]),
      groups: [...this.groups].map(([pgid, a]) => [pgid, pairs(a)]),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data));
    await fs.promises.rename(tmp, file);
  }

  /** What `save` wrote, or an empty lineage when there is nothing readable. */
  static load(file: string): ProcessLineage {
    const lineage = new ProcessLineage();
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
      const ancestors = (v: unknown): Ancestors =>
        new Map(Array.isArray(v) ? v.filter((p): p is [number, number] => Array.isArray(p) && num(p[0]) && num(p[1])) : []);
      for (const e of Array.isArray(data?.entries) ? data.entries : []) {
        if (Array.isArray(e) && num(e[0]) && num(e[1])) lineage.entries.set(e[0], { startedAt: e[1], ancestors: ancestors(e[2]) });
      }
      for (const g of Array.isArray(data?.groups) ? data.groups : []) {
        if (Array.isArray(g) && num(g[0])) lineage.groups.set(g[0], ancestors(g[1]));
      }
    } catch {}
    return lineage;
  }
}
