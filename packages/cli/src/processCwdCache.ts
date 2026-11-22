import { parseLsofPidPaths } from "./sessionProcessMatcher.js";

/**
 * Working directories of live processes, read with one `lsof` for many pids
 * and kept for PROCESS_CWD_TTL_MS.
 *
 * findSessionProcess's cwd strategy reads the cwd of every agent process on
 * the machine, and it runs for every subagent transcript a sync pass touches
 * (a subagent has no process of its own, so nothing earlier finds one). One
 * `lsof -p <pid>` per process, 68 processes, was ~4 lsof clients a second all
 * day on 2026-11-21, each behind a /bin/sh, at 0.8s apiece under load. A cwd
 * barely moves, and a pid the TTL lets through stale is still checked by the
 * caller's process identity backstop.
 */
export const PROCESS_CWD_TTL_MS = 30_000;

/** `lsof -F pn` output for these pids' cwds. Resolves with the partial output when lsof exits non-zero over a dead pid; rejects only when nothing came back. */
export type CwdLister = (pids: number[]) => Promise<string>;

export class ProcessCwdCache {
  private entries = new Map<number, { cwd: string | null; at: number }>();
  private inflight: Promise<void> | null = null;
  /** lsof clients spawned, for tests. */
  runs = 0;

  constructor(
    private readonly list: CwdLister,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PROCESS_CWD_TTL_MS,
  ) {}

  /** pid → its cwd, or null when lsof did not name one (gone, or not readable). */
  async cwds(pids: number[]): Promise<Map<number, string | null>> {
    const wanted = [...new Set(pids)];
    // A read already under way likely covers these pids (the candidates come
    // from one shared ps snapshot): wait for it instead of spawning beside it.
    if (this.inflight && this.stale(wanted).length) await this.inflight;
    const stale = this.stale(wanted);
    if (stale.length) await this.refresh(stale);
    return new Map(wanted.map((pid) => [pid, this.entries.get(pid)?.cwd ?? null]));
  }

  private stale(pids: number[]): number[] {
    const now = this.now();
    return pids.filter((pid) => {
      const e = this.entries.get(pid);
      return !e || now - e.at >= this.ttlMs;
    });
  }

  private refresh(pids: number[]): Promise<void> {
    const run = (async () => {
      this.runs++;
      const at = this.now();
      let out: string;
      // A failed read caches nothing: those pids stay unknown and the next caller asks again.
      try { out = await this.list(pids); } catch { return; }
      const byPid = parseLsofPidPaths(out);
      for (const [pid, e] of this.entries) if (at - e.at >= this.ttlMs) this.entries.delete(pid);
      for (const pid of pids) this.entries.set(pid, { cwd: byPid.get(pid)?.[0] ?? null, at });
    })();
    const tracked = run.finally(() => { if (this.inflight === tracked) this.inflight = null; });
    this.inflight = tracked;
    return tracked;
  }
}
