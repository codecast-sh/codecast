export function createResourceProbeGate() {
  const pending = new Set<string>();
  return async function probe<T>(key: string, run: () => Promise<T>, budgetMs: number): Promise<T | undefined> {
    if (pending.has(key)) return undefined;
    pending.add(key);
    const job = Promise.resolve().then(run).then(value => value, () => undefined).finally(() => pending.delete(key));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), budgetMs); });
    return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
  };
}

export const resourceProbe = createResourceProbeGate();
