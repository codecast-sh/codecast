/**
 * Drop-in replacement for node:child_process that injects `windowsHide: true`
 * into every call. On Windows, a process without a console (the daemon runs
 * detached / under Task Scheduler) gets a NEW VISIBLE console window for every
 * console child it spawns unless windowsHide is set — the daemon's git/codex/
 * cast children painted hundreds of windows on a user's machine. The flag is
 * ignored on POSIX, so injecting it unconditionally is safe everywhere.
 *
 * Import from this module instead of "child_process"; the exported names and
 * signatures are identical, so only the import line changes.
 */
import * as cp from "node:child_process";
import { promisify } from "node:util";
import { SLOW_SYNC_SPAWN_MS, timeSync } from "./slowSync.js";

export type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
  SpawnSyncReturns,
  ExecOptions,
  ExecFileOptions,
} from "node:child_process";

/**
 * Return a copy of a child_process argument list with `windowsHide: true`
 * merged into its options. Every child_process signature is
 * (command[, args][, options][, callback]) — options is the first plain
 * object after the command (skipping the args array), and always precedes a
 * trailing callback. An explicit caller-set windowsHide is respected.
 * Exported for tests.
 */
export function withWindowsHide(args: unknown[]): unknown[] {
  const out = [...args];
  for (let i = 1; i < out.length; i++) {
    const a = out[i];
    if (Array.isArray(a) || typeof a === "string") continue; // args array / encoding
    if (typeof a === "function") {
      out.splice(i, 0, { windowsHide: true }); // no options before callback
      return out;
    }
    if (a && typeof a === "object") {
      out[i] = { windowsHide: true, ...a };
      return out;
    }
    if (a == null) {
      out[i] = { windowsHide: true }; // explicit undefined/null options slot
      return out;
    }
  }
  out.push({ windowsHide: true });
  return out;
}

// A synchronous child process blocks the whole event loop for its lifetime:
// timers, delivery, heartbeats all freeze until it exits. Individually cheap
// calls become a multi-second stall when a sweep runs hundreds back to back
// under load, and nothing in a stack sample survives to name them afterwards.
// So every sync spawn is timed through slowSync.ts and, past the threshold,
// reported through whatever sink the host installs (the daemon points it at
// its log). Runs on every platform: a blocked loop is a blocked loop.
export { SLOW_SYNC_SPAWN_MS } from "./slowSync.js";
function describeSpawnArgs(args: unknown[]): string {
  const cmd = typeof args[0] === "string" ? args[0] : String(args[0]);
  const list = Array.isArray(args[1]) ? ` ${(args[1] as unknown[]).join(" ")}` : "";
  return `${cmd}${list}`.slice(0, 200);
}
function wrapSync<T extends (...args: never[]) => unknown>(name: string, fn: T): T {
  const wrapped = (...args: unknown[]) =>
    timeSync("SLOW-SYNC-SPAWN", SLOW_SYNC_SPAWN_MS, name, () => describeSpawnArgs(args), () =>
      (fn as unknown as (...a: unknown[]) => unknown)(...withWindowsHide(args)));
  return wrapped as unknown as T;
}

function wrap<T extends (...args: never[]) => unknown>(fn: T): T {
  const wrapped = (...args: unknown[]) => (fn as unknown as (...a: unknown[]) => unknown)(...withWindowsHide(args));
  // promisify(execFile)/promisify(exec) resolve {stdout, stderr} only via the
  // promisify.custom implementation on the ORIGINAL function; a bare wrapper
  // would fall back to generic promisification and break destructuring.
  const custom = (fn as Record<symbol, unknown>)[promisify.custom as unknown as symbol];
  if (typeof custom === "function") {
    Object.defineProperty(wrapped, promisify.custom, {
      value: (...args: unknown[]) => (custom as (...a: unknown[]) => unknown)(...withWindowsHide(args)),
      enumerable: false,
    });
  }
  return wrapped as unknown as T;
}

export const spawn: typeof cp.spawn = wrap(cp.spawn);
export const spawnSync: typeof cp.spawnSync = wrapSync("spawnSync", cp.spawnSync);
export const exec: typeof cp.exec = wrap(cp.exec);
export const execSync: typeof cp.execSync = wrapSync("execSync", cp.execSync);
export const execFile: typeof cp.execFile = wrap(cp.execFile);
export const execFileSync: typeof cp.execFileSync = wrapSync("execFileSync", cp.execFileSync);
/** The promise form of the wrapped execFile, shared so no caller promisifies its own copy. */
export const execFileAsync = promisify(execFile);

/** Absolute path `name` resolves to on PATH, or null when it is not installed. */
export function whichBin(name: string): string | null {
  const r = spawnSync("which", [name], { encoding: "utf-8" });
  const found = r.status === 0 ? r.stdout.trim() : "";
  return found || null;
}

/**
 * The human-readable cause inside a crashed child's output.
 *
 * A bun/node child that dies on an uncaught error prints the message first
 * and then a wall of stack frames and source-context lines. Surfacing the
 * TAIL of that (as a naive slice(-500) did) shows commander internals and
 * hides the cause — the web's move strip once displayed "…command.js:1261:25)"
 * for what was really "the aws CLI is not installed". Keep the non-frame
 * lines, from the top.
 */
export function childErrorDetail(stderr: string, stdout = "", maxLen = 500): string {
  return (stderr || stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("at ") && !/^\d+ \|/.test(l) && !/^\^+$/.test(l))
    .join(" — ")
    .slice(0, maxLen);
}
