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
  private parkedSince = 0;
  private parkedLast = false;
  constructor(private readonly startMs: number) {}

  elapsed(now = Date.now()): number {
    return now - this.startMs - this.parkedMs - (this.parkedSince ? now - this.parkedSince : 0);
  }

  /** At the top of each poll: a park the last poll did not see again has ended. */
  beginPoll(now = Date.now()): void {
    if (!this.parkedLast && this.parkedSince) {
      this.parkedMs += now - this.parkedSince;
      this.parkedSince = 0;
    }
    this.parkedLast = false;
  }

  /** This poll found the hand parked; true when the park starts here. */
  park(now = Date.now()): boolean {
    const starts = !this.parkedSince;
    this.parkedSince ||= now;
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
