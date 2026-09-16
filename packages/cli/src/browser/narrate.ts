import { fmt } from "../colors.js";

/**
 * Runs one step of a command and keeps the person at the terminal informed
 * while it runs long.
 *
 * A browser command is a chain of waits: a tab to create, an extension to
 * attach, a page to load. Each is usually well under a second, and then the
 * command's own output is all anyone needs. On a loaded machine any one of
 * them can take tens of seconds, and a silent terminal reads as a hang. So a
 * step says nothing until it has run past `afterMs`, then names what it is
 * waiting on with the time so far, repeating every `everyMs`, and closes with
 * how long it took. A fast step never speaks, and a step that ends soon
 * after its first line gets no closing line: the command's own output is
 * closure enough.
 *
 * Lines go to stderr: they are commentary on the run, not its result, so a
 * caller reading stdout sees exactly what it would have seen otherwise.
 */
export interface NarrateOptions {
  afterMs?: number;
  everyMs?: number;
  /** A hint printed with the first line, e.g. the flag that skips this wait. */
  hint?: string;
  write?: (line: string) => void;
}

export async function narrated<T>(what: string, step: Promise<T>, opts: NarrateOptions = {}): Promise<T> {
  const afterMs = opts.afterMs ?? 1500;
  const everyMs = opts.everyMs ?? 5000;
  const write = opts.write ?? ((line: string) => process.stderr.write(fmt.muted(line) + "\n"));
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  let spoke = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    write(`  still ${what} (${elapsed()})${spoke || !opts.hint ? "" : `; ${opts.hint}`}`);
    spoke = true;
    timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, afterMs);
  try {
    const result = await step;
    clearTimeout(timer);
    if (spoke && Date.now() - started >= afterMs * 2) write(`  finished ${what} after ${elapsed()}`);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
