import { loadScaledMs } from "./machineLoad.js";

/**
 * The one polling wait for tests. Polls `check` every `every` ms until it
 * holds and returns the elapsed ms (for latency assertions). Fails with
 * "<what> timed out" once `ms`, stretched for the machine's load
 * (machineLoad.ts), pass without it holding. A wait over many passes names
 * what each pass advances in `progress`: the budget then restarts on every
 * change, so the wait fails on a stall, not on a slow machine.
 */
export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  what: string,
  { ms = 5000, every = 5, progress }: { ms?: number; every?: number; progress?: () => unknown } = {},
): Promise<number> {
  const start = Date.now();
  const budget = loadScaledMs(ms);
  let seen = JSON.stringify(progress?.());
  let end = start + budget;
  while (!(await check())) {
    const now = JSON.stringify(progress?.());
    if (now !== seen) { seen = now; end = Date.now() + budget; }
    if (Date.now() > end) throw new Error(`${what} timed out` + (progress ? ` at ${now}` : ""));
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  return Date.now() - start;
}
