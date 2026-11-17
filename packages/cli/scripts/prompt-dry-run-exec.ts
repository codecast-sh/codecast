// `--exec` of prompt-dry-run.ts: one command, not an agent, in the closed world.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { refuse, scratchIsolationGap, scratchSandbox } from "./prompt-dry-run-sandbox.ts";
import { WATCHDOG, pidsOf } from "./prompt-dry-run-sweep.ts";

/**
 * `--exec`: one command, not an agent, in the same closed world: writes only
 * in --run, reads only what that world allows plus --cwd and each --read,
 * no network at all, no listening, a home of its own and no credentials. For
 * running code nobody vouches for, such as a model's edit being scored
 * (evals grow.ts). Its stdout and stderr land in exec.out and exec.err in the
 * run dir, its exit code in exit.txt (124 when --timeout ran out), and the
 * harness exits with it. Whatever it left running is killed when it ends.
 *
 *   bun prompt-dry-run.ts --exec --run <dir> [--cwd <dir>] [--read <dir>]... [--timeout <s>] -- <command...>
 */
export async function runExec(): Promise<never> {
  const sep = process.argv.indexOf("--");
  const command = sep >= 0 ? process.argv.slice(sep + 1) : [];
  const flags = sep >= 0 ? process.argv.slice(0, sep) : process.argv;
  const flag = (name: string) => { const i = flags.indexOf(`--${name}`); return i >= 0 ? flags[i + 1] : undefined; };
  const run = flag("run");
  if (!run || !command.length) refuse("usage: prompt-dry-run.ts --exec --run <dir> [--cwd <dir>] [--read <dir>]... [--timeout <s>] -- <command...>");
  const execRun = path.resolve(run!);
  fs.mkdirSync(execRun, { recursive: true });
  const execCwd = path.resolve(flag("cwd") ?? execRun);
  const reads = flags.flatMap((a, i) => (a === "--read" && flags[i + 1] ? [path.resolve(flags[i + 1]!)] : []));
  const guard = path.join(import.meta.dir, "prompt-dry-run-bin");
  const gap = scratchIsolationGap(execRun, guard, fs.realpathSync(execCwd));
  if (gap) refuse(`--exec needs its sandbox, and this machine cannot give it one (${gap})`);
  const sb = scratchSandbox(execRun, { guard, read: [execCwd, ...reads], ports: [] });
  const home = path.join(execRun, "home");
  fs.mkdirSync(home, { recursive: true });
  // Output goes to files, never pipes: a child that detaches holding a pipe would keep the read, and so the harness, waiting past the timeout.
  // Tagged and in a session of its own, with the watchdog behind it, so what it leaves running dies with it however it detached.
  const tag = `dry-run-exec-${crypto.randomUUID()}`;
  const [outFd, errFd] = ["exec.out", "exec.err"].map((f) => fs.openSync(path.join(execRun, f), "w"));
  const child = spawn(sb.prefix[0]!, [...sb.prefix.slice(1), ...command], {
    cwd: execCwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG ?? "en_US.UTF-8", HOME: home, PWD: fs.realpathSync(execCwd), DRY_RUN_TAG: tag, ...sb.env },
    stdio: ["ignore", outFd, errFd], detached: true,
  });
  const dog = spawn("/bin/sh", ["-c", WATCHDOG, "watchdog", String(process.pid), String(child.pid), tag, fs.realpathSync(execRun)], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  dog.unref();
  const group = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* gone */ } };
  let timedOut = false;
  const code = await new Promise<number>((resolve) => {
    const t = setTimeout(() => { timedOut = true; group("SIGKILL"); }, Number(flag("timeout") ?? 600) * 1000);
    child.on("exit", (c, sig) => { clearTimeout(t); resolve(timedOut ? 124 : c ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)); });
  });
  group("SIGKILL");
  const swept = pidsOf(tag, execRun);
  for (const pid of swept) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  dog.kill("SIGKILL");
  fs.writeFileSync(path.join(execRun, "exit.txt"), `${code}\n`);
  fs.writeFileSync(path.join(execRun, "swept.txt"), `${swept.length}\n`);
  process.exit(code);
}
