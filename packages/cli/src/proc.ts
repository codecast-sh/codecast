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
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { routeProbe } from "./workers/bridge.js";
import { promisify } from "node:util";
import { SLOW_SYNC_SPAWN_MS, reportSpawnTimeout, timeSync } from "./slowSync.js";

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
const execFileDirectAsync = promisify(execFile);
export const execFileAsync: typeof execFileDirectAsync = ((file: string, args: string[], options?: unknown) =>
  routeProbe(file, args, options, opts => execFileDirectAsync(file, args, opts as cp.ExecFileOptionsWithStringEncoding))) as typeof execFileDirectAsync;

// A keychain read answers in tens of milliseconds on an idle machine. A locked
// keychain or an access prompt can hang it, and the daemon's credential ticks
// hold an in flight flag for the length of the call, so a hung read would stop
// those ticks for good with nothing in the log. The timeout kills the child;
// the first timeout per item is reported so the stop is visible.
export const KEYCHAIN_READ_TIMEOUT_MS = 30_000;
const keychainTimeoutsReported = new Set<string>();
/** `security <args>` off the loop, trimmed. Rejects like execFileAsync. */
export async function keychainReadAsync(args: string[], timeoutMs = KEYCHAIN_READ_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync("security", args, { encoding: "utf-8", timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    const detail = args.join(" ");
    if ((err as { killed?: boolean }).killed && !keychainTimeoutsReported.has(detail)) {
      keychainTimeoutsReported.add(detail);
      reportSpawnTimeout("security", detail, timeoutMs);
    }
    throw err;
  }
}

/** Absolute path `name` resolves to on PATH (or on `pathEnv`), or null when it is not installed.
 *  Windows has no `which`, so there the PATH is walked here (findOnPath). */
export function whichBin(name: string, pathEnv?: string): string | null {
  if (process.platform === "win32") return findOnPath(name, pathEnv ?? process.env.PATH ?? process.env.Path ?? "");
  const r = spawnSync("which", [name], { encoding: "utf-8", ...(pathEnv ? { env: { ...process.env, PATH: pathEnv } } : {}) });
  const found = r.status === 0 ? r.stdout.trim() : "";
  return found || null;
}

/** `which` done by hand: the first directory on `pathEnv` holding `name`, as
 *  Windows resolves it (each PATHEXT extension tried, `ffmpeg` finding
 *  `ffmpeg.exe`) or as POSIX does (an executable file). Exported for tests,
 *  which pass the platform and a fake file check. */
export function findOnPath(
  name: string,
  pathEnv: string,
  opts: { platform?: NodeJS.Platform; pathext?: string; isFile?: (p: string) => boolean } = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  const win = platform === "win32";
  const pathLib = win ? nodePath.win32 : nodePath.posix;
  const isFile =
    opts.isFile ??
    ((p: string) => {
      try {
        if (!fs.statSync(p).isFile()) return false;
        if (!win) fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const exts = win
    ? ["", ...(opts.pathext ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  // A name that already carries its extension (`ffmpeg.exe`) is tried as is.
  const candidates = (dir: string) => exts.map((ext) => pathLib.join(dir, name + ext));
  if (name.includes("/") || (win && name.includes("\\"))) return candidates("").find(isFile) ?? null;
  for (const dir of pathEnv.split(win ? ";" : ":")) {
    if (!dir) continue;
    const hit = candidates(dir.replace(/^"(.*)"$/, "$1")).find(isFile);
    if (hit) return hit;
  }
  return null;
}

// ── Telling a person how to install a tool ────────────────────────────────
// tmux was the first tool the CLI shells out to that a machine may lack, and
// grew this per-platform ladder; ffmpeg (`cast call snap`) needs the same
// answer, so it lives beside whichBin and both read it. A package manager is
// looked up, never assumed: a Mac without Homebrew gets "install Homebrew,
// then …" rather than a `brew` command that fails, and a Linux box gets the
// manager it actually has.

/** PATH as a login shell would have it. Agents and the daemon often start
 *  with a bare PATH that lacks Homebrew, so a tool installed there would read
 *  as missing. `~/.local/bin` is in the list because it is where an installer
 *  that needs no admin rights puts its binary (herdr's does, and so does any
 *  `pip --user`), which is exactly the machine whose Homebrew is unwritable.
 *  The real PATH comes first, so a tool found today keeps the same hit. */
export const TOOL_PATH =
  process.platform === "win32"
    ? process.env.PATH ?? process.env.Path ?? ""
    : [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", process.env.HOME && nodePath.join(process.env.HOME, ".local/bin")]
        .filter(Boolean)
        .join(nodePath.delimiter);

/** How to name a package manager in a command a person will paste: by name
 *  when their PATH has it, by absolute path when only the login shell's does
 *  (an agent on a bare PATH has /opt/homebrew/bin/brew but no `brew`), null
 *  when the machine lacks it. */
function commandName(bin: string): string | null {
  const found = whichBin(bin, TOOL_PATH);
  if (!found) return null;
  return whichBin(bin) ? bin : found;
}

/** The command that installs `pkg` with a package manager this machine has,
 *  or null when there is none we know. Runnable as is. */
export function installCommandFor(pkg: string): string | null {
  if (process.platform === "darwin") {
    const brew = commandName("brew");
    return brew ? `${brew} install ${pkg}` : null;
  }
  if (process.platform === "linux") {
    for (const [bin, args] of [
      ["apt-get", `install -y ${pkg}`],
      ["dnf", `install -y ${pkg}`],
      ["yum", `install -y ${pkg}`],
      ["pacman", `-S --noconfirm ${pkg}`],
      ["apk", `add ${pkg}`],
    ] as const) {
      const name = commandName(bin);
      if (name) return `sudo ${name} ${args}`;
    }
  }
  return null;
}

/** One sentence a person can act on: the install command when there is one,
 *  otherwise what to do first. `winget` is the package id on Windows, where
 *  a tool's id rarely matches its name. */
export function installHintFor(pkg: string, opts: { winget?: string } = {}): string {
  const cmd = installCommandFor(pkg);
  if (cmd) return `Install it with: ${cmd}`;
  if (process.platform === "darwin") return `Install Homebrew (https://brew.sh), then run: brew install ${pkg}`;
  if (process.platform === "win32" && opts.winget) return `Install it with: winget install ${opts.winget}`;
  return `Install ${pkg} with your system package manager.`;
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
/**
 * The last meaningful line of a child's error output: where a failing command
 * names its cause. A Bun crash ends with its version banner, so that is skipped.
 */
export function lastErrorLine(text: string | undefined | null): string {
  return (text ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^Bun v\d\S* \(/.test(l)).pop() ?? "";
}

export function childErrorDetail(stderr: string, stdout = "", maxLen = 500): string {
  return (stderr || stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("at ") && !/^\d+ \|/.test(l) && !/^\^+$/.test(l))
    .join(" — ")
    .slice(0, maxLen);
}
