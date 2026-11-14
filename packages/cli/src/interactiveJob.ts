/**
 * Run a command at Interactive priority as a one-shot launchd job, relaying
 * its output and exit code.
 *
 * A process an agent starts inherits the daemon's utility QoS clamp (priority
 * 20) and gets a few percent of a core under load: a convex deploy sat most of
 * an hour in its typecheck, a host build ran past its timeout, and `cast spawn
 * --cloud` spent half an hour in its host prepare looking hung (2026-10-02 to
 * 2026-10-05). The same work as a job finishes in minutes. Off macOS, or when
 * launchd will not take the job, the command runs as a plain child.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileAsync, spawnSync } from "./proc.js";
import { LAUNCHD_LABEL_ENV, startLaunchdJob } from "./launchdJob.js";
import { sessionIdFromEnv } from "./sessionIdentity.js";
import { acquireFileSlot } from "./lockFile.js";
import { machineCap } from "./machineCaps.js";
import { defaultConfigDir } from "./config/configDir.js";
import { EXIT_CANCELLED, EXIT_INFRA, printHint } from "./infraExit.js";

/** Priority a process gets when nothing clamps it (the Interactive band starts here). */
const UNCLAMPED_PRIORITY = 31;

/** True on a Mac when this process runs below normal priority and is not already such a job. */
export function priorityClamped(): boolean {
  if (process.platform !== "darwin" || process.env[LAUNCHD_LABEL_ENV]) return false;
  const r = spawnSync("ps", ["-o", "pri=", "-p", String(process.pid)], { encoding: "utf-8", timeout: 5_000 });
  const pri = parseInt(String(r.stdout ?? "").trim(), 10);
  return Number.isFinite(pri) && pri < UNCLAMPED_PRIORITY;
}

/**
 * Run `command` (argv) as an Interactive job in `cwd`. `stdin` is a file the
 * job reads as its standard input. The caller's session identity rides along
 * as CODECAST_SESSION_ID, since the job runs outside the agent's process tree.
 */
export async function runAsInteractiveJob(command: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<number> {
  const runHere = () => spawnSync(command[0]!, command.slice(1), { stdio: "inherit", cwd: opts.cwd }).status ?? 1;
  if (process.platform !== "darwin" || process.env[LAUNCHD_LABEL_ENV]) return runHere();
  // Each job is a scheduling group of its own, so it competes with every agent
  // session as an equal; a cap on how many run at once keeps a burst of them
  // from crowding the sessions out.
  const cap = machineCap("interactive_jobs");
  const release = await acquireFileSlot(INTERACTIVE_JOB_SLOTS_DIR(), cap, {
    describe: "Interactive job slots",
    what: command.join(" "),
    onWait: () => process.stderr.write(`queued: all ${cap} Interactive job slots on this machine are in use (cast queue lists them); starting when one frees\n`),
  });
  try {
    return await runJob(command, opts, runHere);
  } finally {
    release();
  }
}

/** Where the Interactive job slots live; `cast queue` reads them. */
export const INTERACTIVE_JOB_SLOTS_DIR = () => path.join(defaultConfigDir(), "interactive-jobs");

async function runJob(command: string[], opts: { cwd?: string; stdin?: string }, runHere: () => number): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-interactive-"));
  const label = `sh.codecast.interactive.${process.pid}`;
  const logPath = path.join(dir, "out.log");
  const exitPath = path.join(dir, "exit");
  fs.writeFileSync(logPath, "");
  const session = sessionIdFromEnv();
  const env = [`EXIT_FILE=${exitPath}`, `STDIN_FILE=${opts.stdin ?? "/dev/null"}`, ...(session ? [`CODECAST_SESSION_ID=${session}`] : [])];
  // A directory the job cannot enter is the tool's failure, not the command's: the command never ran.
  // The exit code lands by rename, so the poll never reads a file the shell has truncated but not yet written.
  const wrapped = ["/bin/bash", "-c", `cd "$1" || { echo "cast: the Interactive job could not enter $1" >&2; echo ${EXIT_INFRA} > "$EXIT_FILE.tmp"; mv "$EXIT_FILE.tmp" "$EXIT_FILE"; exit 0; }; shift; "$@" < "$STDIN_FILE"; echo $? > "$EXIT_FILE.tmp"; mv "$EXIT_FILE.tmp" "$EXIT_FILE"`, "interactive-job", opts.cwd ?? process.cwd(), ...command];
  if (!startLaunchdJob({ label, argv: ["/usr/bin/env", ...env, ...wrapped], plistPath: path.join(dir, "job.plist"), logPath })) {
    fs.rmSync(dir, { recursive: true, force: true });
    return runHere();
  }
  const uid = process.getuid!();
  const stop = () => { spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { timeout: 10_000 }); };
  const onSignal = () => { stop(); process.exit(EXIT_CANCELLED); };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, onSignal);
  let offset = 0;
  const relay = () => {
    const size = fs.statSync(logPath).size;
    if (size <= offset) return;
    const fd = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    process.stdout.write(buf);
  };
  return new Promise((resolve) => {
    let lastProbe = Date.now();
    let goneSince: number | null = null;
    let probing = false;
    let done = false;
    const finish = (code: number, hint: string | null) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      relay();
      stop();
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(sig, onSignal);
      fs.rmSync(dir, { recursive: true, force: true });
      if (hint) printHint(hint);
      resolve(code);
    };
    const timer = setInterval(() => {
      relay();
      if (fs.existsSync(exitPath)) {
        const raw = fs.readFileSync(exitPath, "utf8").trim();
        const verdict = jobVerdict(raw ? Number(raw) : NaN, command);
        return finish(verdict.code, verdict.hint);
      }
      // A job launchd no longer runs, with no exit written, was killed whole
      // (its wrapper too): without this the caller would wait on it forever.
      if (probing || done || Date.now() - lastProbe < JOB_PROBE_MS) return;
      lastProbe = Date.now();
      probing = true;
      // Off the event loop, so relaying the job's output never waits on launchctl.
      execFileAsync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf-8", timeout: 3_000 })
        .then((r) => launchdJobState(0, String(r.stdout ?? "")), (err: { code?: unknown; stdout?: string }) => launchdJobState(typeof err.code === "number" ? err.code : null, String(err.stdout ?? "")))
        .then((state) => {
          if (done || state.running || fs.existsSync(exitPath)) return void (goneSince = null);
          goneSince ??= Date.now();
          if (Date.now() - goneSince < JOB_PROBE_MS) return;
          process.stderr.write(`cast: the Interactive job for ${command.join(" ")} ended without reporting an exit code${state.detail ? ` (${state.detail})` : ""}\n`);
          finish(EXIT_INFRA, `run it again; if it is killed again, free memory first (it may have been killed for memory)`);
        })
        .finally(() => { probing = false; });
    }, 250);
  });
}

const JOB_PROBE_MS = 5_000;
const LAUNCHCTL_NO_SUCH_SERVICE = 113;

/**
 * Whether `launchctl print` says the job has ended, and how. Only an unloaded
 * job or `state = not running` counts as ended: a job still being spawned on
 * a loaded machine shows other states, and must not be failed for it.
 */
export function launchdJobState(status: number | null, text: string): { running: boolean; detail: string | null } {
  // 113 is launchctl's "could not find service". A timeout (null) or any other failure says nothing.
  if (status === LAUNCHCTL_NO_SUCH_SERVICE) return { running: false, detail: null };
  if (status !== 0) return { running: true, detail: null };
  if (!/^\s*state = not running\b/m.test(text)) return { running: true, detail: null };
  const signal = /^\s*last terminating signal = (.+)$/m.exec(text)?.[1]?.trim();
  const code = /^\s*last exit code = (.+)$/m.exec(text)?.[1]?.trim();
  return { running: false, detail: signal ? `last signal: ${signal}` : code ? `last exit code ${code}` : null };
}

/**
 * The code a finished job hands back, and a hint when it is not the
 * command's own verdict. A SIGKILL (bash reports 137) is almost always the
 * memory killer, and the command reached no verdict, so it is reported as the
 * tool's failure (infraExit.ts).
 */
export function jobVerdict(code: number, command: readonly string[]): { code: number; hint: string | null } {
  if (!Number.isFinite(code)) return { code: EXIT_INFRA, hint: `run \`${command.join(" ")}\` again; the Interactive job wrote no exit code` };
  if (code === 137) return { code: EXIT_INFRA, hint: `free memory, then run it again: the command was killed (SIGKILL), most likely for memory` };
  if (code === 127) return { code, hint: `a program the job runs was not found on its PATH (\`${command[0]}\` or one it calls); install it or use a full path` };
  return { code, hint: null };
}

/**
 * The commands whose work is heavy enough to starve under the clamp: cloud
 * placement (`spawn`/`fork` with --cloud) and the host verbs that build,
 * upload or mirror. `args` is argv after the binary.
 */
export function wantsInteractivePriority(args: readonly string[]): boolean {
  const [verb, sub] = args;
  const options = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if ((verb === "spawn" || verb === "fork") && options.some((a) => a === "--cloud" || a.startsWith("--cloud="))) return true;
  return verb === "hosts" && ["update", "wake", "setup", "provision", "sync"].includes(sub ?? "");
}
