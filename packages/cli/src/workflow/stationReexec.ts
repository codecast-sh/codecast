// A parked station (CI's, Deploy's wait, Wait for main) runs for up to hours
// on the binary it started on. `cast update` renames a new binary over
// process.execPath and the running station keeps the old one in memory, so a
// fix released meanwhile never reached a run in flight: ct-99126's CI station
// kept reporting preexisting: [] after the laptop moved from 1.1.263 to 1.1.265.
//
// So between polls a station asks whether the installed binary is still the
// one it started on. When another file is there and it reports a newer
// version, the station runs the same command on it, handing over its place
// (what it has done and when it started) in CODECAST_STATION_RESUME, and exits
// with that run's code. The older process stays as the newer one's parent
// until it ends, so the runner's view of the station (its process group, its
// stdout, its exit code) does not change; the cost is one more resident
// process per hop, so a station hops at most MAX_HOPS times.
//
// The newer run acknowledges the place as it starts, before its first poll.
// One that ends without acknowledging (it crashed at boot, Gatekeeper stopped
// it, it no longer knows a flag) never took the station: the older process
// keeps polling itself and never tries that file again. An older or equal
// version is never taken either, so a rollback leaves the station where it is.
//
// Only between polls: nothing the station does is in flight there, and a
// station with a side effect still out (a deploy it sent) does not ask.
// A run from source (bun src/index.ts) never swaps: bun is not cast. Nor does
// a Homebrew install, whose upgrade puts the new version at a new Cellar path
// and leaves this one's file in place. The path is read once, as the station
// starts: on Linux, where /proc/self/exe of a replaced binary reads
// "<path> (deleted)", the path watched is still the installed one (not
// verified on a Linux machine).
//
// Bun hands a child the environment the process started with unless it is
// given one, so deleting the variable does not keep it from what the station
// starts (gh, `cast line deploy targets`). A place is therefore taken only by
// the direct child it was handed to (its parent pid) running this same command.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compareVersions } from "@platform/cli-kit/update";
import { spawn, spawnSync } from "../proc.js";
import { isCompiledEntry } from "../castInvocation.js";
import { getVersion } from "../cliVersion.js";

export const RESUME_ENV = "CODECAST_STATION_RESUME";
/** How many times one station moves to a newer CLI: each hop keeps the older process resident until the station ends. */
export const MAX_HOPS = 2;

export type StationCli = {
  /** The place an older binary's run of this same command handed over, else null. */
  resumed<T>(): T | null;
  /** Between polls: when a newer CLI is installed, run it with `place` and exit with its code once it has taken the station. */
  between(place: unknown): Promise<void>;
};

type Image = { ino: number; dev: number; mtimeMs: number; size: number };
type Handed = { args: string[]; parent: number; ack: string; hops: number; place: unknown };

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
  /** How to run the installed binary with arguments. Default: the binary itself, verbs and flags as given. */
  command?: (args: string[]) => { executablePath: string; args: string[] };
  /** This process's version. */
  version?: string;
  exit?: (code: number) => never;
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  log?: (line: string) => void;
};

/**
 * How to run the compiled binary: itself, the arguments as given. Not selfExecInfo's `-- <verb>` form, after which
 * commander reads every flag as an operand (`cast -- flow ci --pr 7` says --pr is missing), and which an npm install
 * (a binary under node_modules) takes for a source run.
 */
const compiled = (binary: string) => (args: string[]) => ({ executablePath: binary, args });

/** The station's handle on its own binary, taken when the station starts: the image it runs is the one installed now. */
export function stationCli(opts: StationCliOptions = {}): StationCli {
  const env = opts.env ?? process.env;
  const binary = opts.binary !== undefined ? opts.binary : isCompiledEntry(process.argv[1] ?? "") ? process.execPath : null;
  const args = opts.args ?? process.argv.slice(process.argv[2] === "--" ? 3 : 2);
  const command = opts.command ?? (binary ? compiled(binary) : null);
  const version = opts.version ?? getVersion();
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.error(line));
  // The file this process runs, and every other one judged not to take the station (not newer, or it failed to).
  const started = binary ? imageOf(binary) : null;
  const passed: Image[] = [];

  const handed = env[RESUME_ENV];
  delete env[RESUME_ENV];
  let place: unknown = null;
  let hops = 0;
  if (handed) {
    try {
      const h = JSON.parse(handed) as Handed;
      if (h.parent === (opts.ppid ?? process.ppid) && JSON.stringify(h.args) === JSON.stringify(args)) {
        place = h.place ?? null;
        hops = h.hops;
        // Taken: the older process may exit with this run's code now.
        fs.writeFileSync(h.ack, String(process.pid));
      }
    } catch { /* a place that does not parse or cannot be acknowledged is no place: start over */ }
  }
  const cleanEnv = () => { const { [RESUME_ENV]: _, ...rest } = env; return rest; };

  /** The installed file's version, from the file itself; null when it does not say one. */
  const installedVersion = (): string | null => {
    const run = command!(["--version"]);
    const r = spawnSync(run.executablePath, run.args, { encoding: "utf-8", timeout: 30_000, env: cleanEnv() });
    return r.status === 0 ? /\d+\.\d+\.\d+/.exec(String(r.stdout))?.[0] ?? null : null;
  };

  return {
    resumed: <T>() => place as T | null,
    async between(now: unknown) {
      if (!binary || !started || !command || hops >= MAX_HOPS) return;
      const installed = imageOf(binary);
      if (!installed || sameImage(installed, started) || passed.some((p) => sameImage(p, installed))) return;
      const newer = installedVersion();
      if (!newer || compareVersions(newer, version) <= 0) { passed.push(installed); return; }
      const ack = path.join(os.tmpdir(), `cast-station-${process.pid}-${Date.now()}.ack`);
      const run = command(args);
      const child = spawn(run.executablePath, run.args, {
        stdio: "inherit",
        env: { ...cleanEnv(), [RESUME_ENV]: JSON.stringify({ args, parent: process.pid, ack, hops: hops + 1, place: now } satisfies Handed) },
      });
      const forwards = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((s) => [s, () => { try { child.kill(s); } catch { /* gone */ } }] as const);
      for (const [s, f] of forwards) process.on(s, f);
      const code = await new Promise<number>((resolve) => {
        child.on("error", () => resolve(1));
        child.on("exit", (c, signal) => resolve(c ?? 128 + ((signal && os.constants.signals[signal]) || 0)));
      });
      const took = fs.existsSync(ack);
      try { fs.rmSync(ack, { force: true }); } catch { /* tmp */ }
      if (took) exit(code);
      for (const [s, f] of forwards) process.off(s, f);
      passed.push(installed);
      log(`cast ${newer} did not take this station over (it exited ${code} before resuming); staying on ${version}`);
    },
  };
}
