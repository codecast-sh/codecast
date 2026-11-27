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

/** An entry this old is dropped on load: its row is long gone, and a beat to it does nothing. */
export const PARK_LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A set of parked session ids that writes itself to `file` on every change,
 * once `restore` has named the file. Before that it is a plain set, so tests
 * that import the daemon never touch the real ledger.
 */
export class ParkLedger extends Set<string> {
  private parkedAt = new Map<string, number>();
  private file: string | null = null;

  /** Read the ledger and start persisting. Returns the ids restored. */
  restore(file: string, now: number, skip: (sessionId: string) => boolean = () => false): string[] {
    this.file = file;
    const restored: string[] = [];
    let raw: Record<string, unknown> = {};
    try { raw = JSON.parse(fs.readFileSync(file, "utf-8")); } catch {}
    for (const [id, at] of Object.entries(raw)) {
      if (typeof at !== "number" || now - at > PARK_LEDGER_TTL_MS || skip(id) || super.has(id)) continue;
      super.add(id);
      this.parkedAt.set(id, at);
      restored.push(id);
    }
    this.save();
    return restored;
  }

  add(id: string): this {
    super.add(id);
    this.parkedAt.set(id, Date.now());
    this.save();
    return this;
  }

  delete(id: string): boolean {
    const had = super.delete(id);
    this.parkedAt.delete(id);
    if (had) this.save();
    return had;
  }

  private save(): void {
    if (!this.file) return;
    try { writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.parkedAt))); } catch {}
  }
}
