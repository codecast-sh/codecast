/**
 * Watch a detached helper launch long enough to say why it failed.
 *
 * Every launch in this feature is detached: the helper outlives the CLI
 * process that started it, which is the whole point of the instance file. The
 * launches used to be detached with `stdio: "ignore"` as well, and that made
 * every distinct failure arrive as the same sentence — a missing bundle, a
 * signature macOS refuses, a socket path over the 104-byte `sun_path` limit
 * and a plain crash all read as a timeout seconds later (ct-49674). One of
 * them cost real time to find: `resolveCastInvocation()` handed the disclaim
 * wrapper a path that did not exist, the spawn died with ENOENT immediately,
 * and the only symptom anyone ever saw was "timed out checking permissions".
 *
 * Why a file and not a pipe. A pipe makes the parent the reader of a process
 * that outlives it, and the parent here is a short-lived CLI: after it exits,
 * the helper's next write to stderr takes SIGPIPE. A file is written by the
 * child and read after the fact by whoever is still around, and both callers
 * already create — and clean up — a private directory to put it in.
 */

import * as fs from "node:fs";
import { spawn, type ChildProcess } from "../proc.js";

/** How much of the child's stderr an error message carries. Enough for a dyld
 *  failure or a Swift trap, short of pasting a log into an agent's context. */
const STDERR_TAIL_BYTES = 1_500;

export interface ObservedLaunch {
  child: ChildProcess;
  /** How the child died, or null while it is still running. */
  exitReason(): string | null;
  /** A bounded, single-line tail of what the child wrote to stderr, or "". */
  said(): string;
  /** Both of the above as one clause to append to an error message, or "". */
  explain(): string;
  /** Stop listening. The log file is the caller's to remove. */
  cleanup(): void;
}

/**
 * Spawn detached, with stderr to `logFile`, and remember how it ends.
 *
 * The caller keeps the reference alive for as long as it cares; the child is
 * unref'd, so an observer nobody consults never holds the process open.
 */
export function spawnObserved(cmd: string, args: string[], logFile: string): ObservedLaunch {
  const fd = fs.openSync(logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(cmd, args, { detached: true, stdio: ["ignore", "ignore", fd] });
  } finally {
    // The child holds its own dup of the descriptor.
    fs.closeSync(fd);
  }
  child.unref();

  let reason: string | null = null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    reason = typeof code === "number" ? `exited with code ${code}` : `was killed by ${signal ?? "an unknown signal"}`;
  };
  const onError = (err: Error) => {
    reason = `could not be launched: ${err.message}`;
  };
  child.once("exit", onExit);
  child.once("error", onError);

  const said = (): string => readStderrTail(logFile);
  return {
    child,
    exitReason: () => reason,
    said,
    explain: () => {
      const tail = said();
      if (!reason && !tail) return "";
      return [reason, tail && `it wrote: ${tail}`].filter(Boolean).join("; ");
    },
    cleanup: () => {
      child.off("exit", onExit);
      child.off("error", onError);
    },
  };
}

/** The last of what the child said, collapsed to one line so it fits in an
 *  error message and in a `--json` envelope. */
function readStderrTail(logFile: string): string {
  let raw: string;
  try {
    const { size } = fs.statSync(logFile);
    if (!size) return "";
    const start = Math.max(0, size - STDERR_TAIL_BYTES);
    const fd = fs.openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  return raw.replace(/\s+/g, " ").trim();
}
