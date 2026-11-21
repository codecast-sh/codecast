// A hand parked on a wait its task names (a time, a PR, a decision:
// task-graph.md TG2) waits like a run at a card: the node's clock stops until
// the wait clears, and admission counts no machine for it. Nine Build hands
// that had committed their fix and parked until a spent eval budget rolled
// over were killed at 90 minutes (2026-10-23). A hand parked on a usage limit
// or a throttle stops the clock the same way (runner.ts).
import { waitLabel, type TaskWait } from "@codecast/shared/tasks";

/** A node's clock that leaves out the time its hand spends parked: from the first poll that finds it parked to the first that does not. */
export class ParkedClock {
  private parkedMs = 0;
  private parkedSince: number | null = null;
  private parkedLast = false;
  // It also leaves out the time the machine sleeps. A laptop closed for hours
  // woke to a first poll whose wall clock read past the hand's timeout, and
  // the station failed though nothing had been waited on (ct-98526). The clock
  // runs on performance.now(), which stops while the machine is suspended
  // (the daemon's suspend detection rests on the same fact: suspendClock.ts).
  private readonly offsetMs: number;
  constructor(startMs: number, private readonly awakeNow: () => number = () => performance.now(), wallNow: () => number = Date.now) {
    // Wall time between startMs and this clock's creation counts as it was.
    this.offsetMs = wallNow() - startMs - awakeNow();
  }

  private now(): number {
    return this.awakeNow() + this.offsetMs;
  }

  elapsed(): number {
    const now = this.now();
    return now - this.parkedMs - (this.parkedSince === null ? 0 : now - this.parkedSince);
  }

  /** At the top of each poll: a park the last poll did not see again has ended. */
  beginPoll(): void {
    if (!this.parkedLast && this.parkedSince !== null) {
      this.parkedMs += this.now() - this.parkedSince;
      this.parkedSince = null;
    }
    this.parkedLast = false;
  }

  /** This poll found the hand parked; true when the park starts here. */
  park(): boolean {
    const starts = this.parkedSince === null;
    this.parkedSince ??= this.now();
    this.parkedLast = true;
    return starts;
  }
}

/** What a run's task waits on while a wait is open (its first one, in words), else null. */
export async function taskWaiting(call: (route: string, body: Record<string, any>) => Promise<any>, taskId: string | undefined): Promise<string | null> {
  if (!taskId) return null;
  const task = await call("/cli/work/get", { short_id: taskId });
  if (!task?.waiting_since) return null;
  const open = (task.waits ?? []).find((w: TaskWait) => w.state === "waiting");
  return open ? waitLabel(open) : "a wait";
}
