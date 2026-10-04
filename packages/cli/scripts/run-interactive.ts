// Run a command as a one-shot launchd job at Interactive priority, relay its
// output, and exit with its code. A command started from an agent shell
// inherits the daemon's utility QoS clamp (priority 20) and gets a few percent
// of a core under load: a convex deploy sat most of an hour in its typecheck
// that way (2026-10-02, again 2026-10-04) while holding the deploy lock every
// other session waits on. As a job it finishes in minutes. Off macOS, or when
// launchd will not take the job, the command runs as a plain child.
//
//   bun packages/cli/scripts/run-interactive.ts -- <command> [args...]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { LAUNCHD_LABEL_ENV, startLaunchdJob } from "../src/launchdJob";

const sep = process.argv.indexOf("--");
const command = sep >= 0 ? process.argv.slice(sep + 1) : process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: run-interactive.ts -- <command> [args...]");
  process.exit(2);
}

function runHere(): never {
  const r = spawnSync(command[0]!, command.slice(1), { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

if (process.platform !== "darwin" || process.env[LAUNCHD_LABEL_ENV]) runHere();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-interactive-"));
const label = `sh.codecast.interactive.${process.pid}`;
const logPath = path.join(dir, "out.log");
const exitPath = path.join(dir, "exit");
fs.writeFileSync(logPath, "");
const wrapped = ["/bin/bash", "-c", 'cd "$1" && shift && "$@"; echo $? > "$EXIT_FILE"', "run-interactive", process.cwd(), ...command];
const started = startLaunchdJob({ label, argv: ["/usr/bin/env", `EXIT_FILE=${exitPath}`, ...wrapped], plistPath: path.join(dir, "job.plist"), logPath });
if (!started) runHere();

const uid = process.getuid!();
const stop = () => { spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { timeout: 10_000 }); };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { stop(); process.exit(130); });

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
const timer = setInterval(() => {
  relay();
  if (!fs.existsSync(exitPath)) return;
  clearInterval(timer);
  relay();
  const code = Number(fs.readFileSync(exitPath, "utf8").trim());
  stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(Number.isFinite(code) ? code : 1);
}, 250);
