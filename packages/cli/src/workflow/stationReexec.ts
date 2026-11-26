// A parked station (CI's, Deploy's wait, Wait for main) runs for up to hours
// on the binary it started on. `cast update` renames a new binary over
// process.execPath and the running station keeps the old one in memory, so a
// fix released meanwhile never reached a run in flight: ct-99126's CI station
// kept reporting preexisting: [] after the laptop moved from 1.1.263 to 1.1.265.
//
// So between polls a station asks whether the installed binary is still the
// one it started on. When it is not, it runs the same command on the new one,
// handing over its place (what it has done and when it started) in
// CODECAST_STATION_RESUME, and exits with that run's code. The older process
// stays as the newer one's parent until it ends, so the runner's view of the
// station (its process group, its stdout, its exit code) does not change.
// Only between polls: nothing the station does is in flight there, and a
// station with a side effect still out (a deploy it sent) does not ask.
// A run from source (bun src/index.ts) never swaps: bun is not cast.
import * as fs from "node:fs";
import { spawn } from "../proc.js";
import { isCompiledEntry } from "../castInvocation.js";
import { selfExecInfo } from "../selfExec.js";

export const RESUME_ENV = "CODECAST_STATION_RESUME";

export type StationCli = {
  /** The place an older binary's run of this same command handed over, else null. */
  resumed<T>(): T | null;
  /** Between polls: when the installed CLI is a newer file than this process runs, run it with `place` and exit with its code. */
  between(place: unknown): Promise<void>;
};

type Image = { ino: number; dev: number; mtimeMs: number; size: number };

function imageOf(file: string): Image | null {
  try {
    const s = fs.statSync(file);
    return { ino: s.ino, dev: s.dev, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    // Mid-swap the path is briefly gone: no answer, ask again at the next poll.
    return null;
  }
}

const sameImage = (a: Image, b: Image) => a.ino === b.ino && a.dev === b.dev && a.mtimeMs === b.mtimeMs && a.size === b.size;

export type StationCliOptions = {
  /** The installed binary to watch; null never swaps. Default: this binary when compiled, else null. */
  binary?: string | null;
  /** This command's arguments, handed to the newer binary unchanged. */
  args?: string[];
  /** How to run the newer binary with `args`. */
  command?: (args: string[]) => { executablePath: string; args: string[] };
  exit?: (code: number) => never;
  env?: NodeJS.ProcessEnv;
};

/** The station's handle on its own binary, taken when the station starts: the image it runs is the one installed now. */
export function stationCli(opts: StationCliOptions = {}): StationCli {
  const env = opts.env ?? process.env;
  const binary = opts.binary !== undefined ? opts.binary : isCompiledEntry(process.argv[1] ?? "") ? process.execPath : null;
  const args = opts.args ?? process.argv.slice(process.argv[2] === "--" ? 3 : 2);
  const command = opts.command ?? ((a: string[]) => selfExecInfo(...a));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const started = binary ? imageOf(binary) : null;
  // Taken off the environment, so nothing this station starts (gh, a `cast` call) sees it.
  const handed = env[RESUME_ENV];
  delete env[RESUME_ENV];
  let place: unknown = null;
  if (handed) {
    try {
      const parsed = JSON.parse(handed);
      // Only a place this same command handed over.
      if (JSON.stringify(parsed?.args) === JSON.stringify(args)) place = parsed.place ?? null;
    } catch { /* a place that does not parse is no place: start over */ }
  }
  return {
    resumed: <T>() => place as T | null,
    async between(now: unknown) {
      if (!binary || !started) return;
      const installed = imageOf(binary);
      if (!installed || sameImage(installed, started)) return;
      const run = command(args);
      const child = spawn(run.executablePath, run.args, { stdio: "inherit", env: { ...env, [RESUME_ENV]: JSON.stringify({ args, place: now }) } });
      const forward = (signal: NodeJS.Signals) => () => { try { child.kill(signal); } catch { /* gone */ } };
      for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, forward(s));
      const code = await new Promise<number>((resolve) => {
        child.on("error", () => resolve(1));
        child.on("exit", (c, signal) => resolve(c ?? (signal ? 128 : 1)));
      });
      exit(code);
    },
  };
}
