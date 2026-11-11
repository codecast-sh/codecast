// Times the steps of one slow operation: mark() after each step, summary() for the log line.

export function stepTimer(now: () => number = Date.now) {
  const t0 = now();
  let last = t0;
  const steps: string[] = [];
  return {
    mark(name: string): void {
      const t = now();
      steps.push(`${name}=${t - last}`);
      last = t;
    },
    summary(): string {
      return `${steps.join(" ")} total=${now() - t0}ms`;
    },
  };
}
