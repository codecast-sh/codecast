/** A probe's budget counts only time the event loop was awake. When the loop
 *  freezes (a synchronous spawn, CPU starvation), the deadline timer and the
 *  probe's finished child are both queued, and timers run first: a plain
 *  deadline then discards a result that arrived inside its budget. A late
 *  deadline re-arms for the time it was late, so queued results land first;
 *  the whole wait stays under four budgets. */
export function createResourceProbeGate() {
  const pending = new Set<string>();
  return async function probe<T>(key: string, run: () => Promise<T>, budgetMs: number): Promise<T | undefined> {
    if (pending.has(key)) return undefined;
    pending.add(key);
    const job = Promise.resolve().then(run).then(value => value, () => undefined).finally(() => pending.delete(key));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const timeout = new Promise<undefined>(resolve => {
      const arm = (ms: number) => {
        const due = Date.now() + ms;
        timer = setTimeout(() => {
          const late = Date.now() - due;
          if (late > 50 && Date.now() - started < 4 * budgetMs) arm(Math.min(late, budgetMs));
          else resolve(undefined);
        }, ms);
      };
      arm(budgetMs);
    });
    return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
  };
}

export const resourceProbe = createResourceProbeGate();
