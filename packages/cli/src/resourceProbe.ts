/** A probe's budget counts only time the event loop was awake. When the loop
 *  freezes (a synchronous spawn, CPU starvation), the deadline timer and the
 *  probe's finished child are both queued, and timers run first: a deadline
 *  measured in wall time then discards a result that arrived inside its
 *  budget. Under load the daemon's loop freezes for 30 to 80s at a time, so
 *  every wall-time cap shorter than that lost the process list exactly when
 *  the Resources page needed it. The deadline instead ticks in short steps and
 *  credits only the steps that fired on time, so a freeze costs nothing and
 *  queued results land before the next step. A child that truly hangs is
 *  killed by its own timeout; a run that never settles gives up after its
 *  awake budget, or after WALL_CAP_MS when the loop never stays awake. */
const STEP_MS = 100;
const LATE_MS = 50;
const WALL_CAP_MS = 180_000;

export function createResourceProbeGate() {
  // A caller that arrives while the same probe runs shares that run (one child per key), on its own deadline.
  const pending = new Map<string, Promise<unknown>>();
  return async function probe<T>(key: string, run: () => Promise<T>, budgetMs: number): Promise<T | undefined> {
    let job = pending.get(key) as Promise<T | undefined> | undefined;
    if (!job) {
      job = Promise.resolve().then(run).then(value => value, () => undefined).finally(() => pending.delete(key));
      pending.set(key, job);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>(resolve => {
      let awake = 0;
      const started = Date.now();
      const step = () => {
        const ms = Math.min(STEP_MS, budgetMs - awake);
        const armed = Date.now();
        timer = setTimeout(() => {
          if (Date.now() - armed <= ms + LATE_MS) awake += ms;
          if (awake >= budgetMs || Date.now() - started >= Math.max(WALL_CAP_MS, 4 * budgetMs)) resolve(undefined);
          else step();
        }, ms);
      };
      step();
    });
    return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
  };
}

export const resourceProbe = createResourceProbeGate();
