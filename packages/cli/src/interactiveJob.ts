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
import { spawnSync } from "./proc.js";
import { LAUNCHD_LABEL_ENV, startLaunchdJob } from "./launchdJob.js";
import { sessionIdFromEnv } from "./sessionIdentity.js";
import { acquireFileSlot } from "./lockFile.js";
import { defaultConfigDir } from "./config/configDir.js";

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
  const release = await acquireFileSlot(path.join(defaultConfigDir(), "interactive-jobs"), MAX_INTERACTIVE_JOBS, {
    describe: "Interactive job slots",
    onWait: () => process.stderr.write(`queued: all ${MAX_INTERACTIVE_JOBS} Interactive job slots are in use on this machine; starting when one frees\n`),
  });
  try {
    return await runJob(command, opts, runHere);
  } finally {
    release();
  }
}

/** How many commands may run as Interactive jobs at once on this machine (CAST_INTERACTIVE_JOBS_MAX overrides). */
export const MAX_INTERACTIVE_JOBS = Math.max(1, parseInt(process.env.CAST_INTERACTIVE_JOBS_MAX ?? "", 10) || 8);

async function runJob(command: string[], opts: { cwd?: string; stdin?: string }, runHere: () => number): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-interactive-"));
  const label = `sh.codecast.interactive.${process.pid}`;
  const logPath = path.join(dir, "out.log");
  const exitPath = path.join(dir, "exit");
  fs.writeFileSync(logPath, "");
  const session = sessionIdFromEnv();
  const env = [`EXIT_FILE=${exitPath}`, `STDIN_FILE=${opts.stdin ?? "/dev/null"}`, ...(session ? [`CODECAST_SESSION_ID=${session}`] : [])];
  const wrapped = ["/bin/bash", "-c", 'cd "$1" && shift && "$@" < "$STDIN_FILE"; echo $? > "$EXIT_FILE"', "interactive-job", opts.cwd ?? process.cwd(), ...command];
  if (!startLaunchdJob({ label, argv: ["/usr/bin/env", ...env, ...wrapped], plistPath: path.join(dir, "job.plist"), logPath })) {
    fs.rmSync(dir, { recursive: true, force: true });
    return runHere();
  }
  const uid = process.getuid!();
  const stop = () => { spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { timeout: 10_000 }); };
  const onSignal = () => { stop(); process.exit(130); };
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
    const timer = setInterval(() => {
      relay();
      if (!fs.existsSync(exitPath)) return;
      clearInterval(timer);
      relay();
      const code = Number(fs.readFileSync(exitPath, "utf8").trim());
      stop();
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(sig, onSignal);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(Number.isFinite(code) ? code : 1);
    }, 250);
  });
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
