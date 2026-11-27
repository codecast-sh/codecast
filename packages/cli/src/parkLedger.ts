import fs from "node:fs";
import { writeFileAtomic } from "./fsAtomic.js";

// The sessions this daemon parked, kept on disk so a restart keeps beating them.
//
// A parked session holds no pane and no process, so nothing a booting daemon
// scans finds it: liveness reconcile looks for agents, transcript sync for
// writers. Held only in memory, the set emptied on every restart, the parked
// sessions stopped beating, and the inbox filed sessions whose Ship run was
// still live under Needs You, because a run wake counts only on a beating
// session (ct-102132, after a `cast update` restart on 2026-11-26).
//
// An entry leaves only the way it leaves the in-memory set: the session wakes
// or is torn down. It has no age limit, since the server never reaps a
// hibernated row (managedSessions.reapStaleManagedSessions), so a park of any
// age is one that should still beat.

/**
 * A set of parked session ids that writes itself to `file` on every change,
 * once `restore` has named the file. Before that it is a plain set, so tests
 * that import the daemon never touch the real ledger.
 */
export class ParkLedger extends Set<string> {
  private file: string | null = null;

  /** Read the ledger and start persisting. Returns the ids restored. */
  restore(file: string, skip: (sessionId: string) => boolean = () => false): string[] {
    this.file = file;
    const restored: string[] = [];
    let raw: unknown = [];
    try { raw = JSON.parse(fs.readFileSync(file, "utf-8")); } catch {}
    for (const id of Array.isArray(raw) ? raw : []) {
      if (typeof id !== "string" || skip(id) || super.has(id)) continue;
      super.add(id);
      restored.push(id);
    }
    this.save();
    return restored;
  }

  /** Stop persisting (tests): later changes write nothing. */
  detach(): void {
    this.file = null;
  }

  add(id: string): this {
    const had = super.has(id);
    super.add(id);
    if (!had) this.save();
    return this;
  }

  delete(id: string): boolean {
    const had = super.delete(id);
    if (had) this.save();
    return had;
  }

  private save(): void {
    if (!this.file) return;
    try { writeFileAtomic(this.file, JSON.stringify([...this])); } catch {}
  }
}
