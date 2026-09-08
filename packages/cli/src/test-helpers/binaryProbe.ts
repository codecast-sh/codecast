// Is a binary installed? The gate every real-tmux suite skips itself on.
//
// Why this is not a one-liner (ct-49770): the probe used to be
// `spawnSync("which", [name]).status === 0`, and every non-zero status read as
// "the binary is absent". Under load a spawn fails for reasons that say nothing
// about the install — fork returns EAGAIN, the box is out of memory, the child
// is killed by a signal — and the suite then skipped itself. Silently: a real
// injection suite reported `0 pass 2 skip 0 fail` in two seconds on a machine
// that had found `claude` on PATH a minute earlier, and the tally read as green.
//
// So this module answers three ways, not two:
//  - installed        -> true
//  - definitely absent -> false (`which` ran and said no; CI stays green here)
//  - could not ask     -> retry briefly, then THROW with the errno.
//
// A throw at gate time turns the whole test file red, which is the point: a
// gate whose failure mode is silence hides broken suites, and a skipped run
// counts as a passing run in every tally that matters.

import { spawnSync } from "node:child_process";

/** What one probe attempt reports. Mirrors the fields of `spawnSync`. */
export interface ProbeResult {
  status: number | null;
  stdout: string;
  signal?: NodeJS.Signals | null;
  error?: Error & { code?: string };
}

export interface ProbeOptions {
  /** Probe runner. Injected by the tests to fake a spawn failure. */
  spawn?: (name: string) => ProbeResult;
  /** Total attempts before giving up. */
  attempts?: number;
  /** Base backoff between attempts; grows linearly. */
  delayMs?: number;
  /** Sleep between attempts. Injected by the tests to keep them instant. */
  sleep?: (ms: number) => void;
}

function defaultSpawn(name: string): ProbeResult {
  const r = spawnSync("which", [name], {
    encoding: "utf8",
    // A wedged probe must not hang the suite; the kill surfaces as a signal,
    // which is "could not ask", not "absent".
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  return { status: r.status, stdout: r.stdout ?? "", signal: r.signal, error: r.error as ProbeResult["error"] };
}

function sleepSync(ms: number): void {
  // No child process: spawning `sleep` to recover from a failed spawn would be
  // the same bet that just lost.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Why this attempt could not answer the question, or null when it did. */
function couldNotAsk(r: ProbeResult): string | null {
  if (r.error) return `${r.error.code ?? "spawn failed"}: ${r.error.message}`;
  if (r.signal) return `killed by ${r.signal}`;
  if (r.status === null) return "no exit status";
  return null;
}

const resolved = new Map<string, boolean>();

/**
 * True when `name` is on PATH, false when it demonstrably is not.
 *
 * Throws when the probe itself could not run — see the header. Resolved once
 * per binary per process, so a suite that gates dozens of tests spawns one
 * `which` per name rather than one per test.
 */
export function hasBinary(name: string, opts: ProbeOptions = {}): boolean {
  const cached = resolved.get(name);
  if (cached !== undefined) return cached;

  const spawn = opts.spawn ?? defaultSpawn;
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? 50;
  const sleep = opts.sleep ?? sleepSync;

  const failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = spawn(name);
    const reason = couldNotAsk(r);
    if (reason === null) {
      const found = r.status === 0 && r.stdout.trim().length > 0;
      resolved.set(name, found);
      return found;
    }
    failures.push(`attempt ${attempt}: ${reason}`);
    if (attempt < attempts) sleep(delayMs * attempt);
  }

  throw new Error(
    `cannot tell whether \`${name}\` is installed: every probe failed to spawn ` +
    `(${failures.join("; ")}). Failing instead of skipping — a suite that skips ` +
    `itself here reports 0 pass 0 fail and reads as green (ct-49770).`,
  );
}

/** Forget what was resolved. For tests that probe the same name twice. */
export function resetBinaryProbeCache(): void {
  resolved.clear();
}
