/**
 * How `cast run` reaches a host (run/client.ts): ssh in production, a local
 * shell standing in for one in tests, the shell line that installs and calls
 * the host runner, and picking a host by what its runner reports.
 */

import type { ChildProcess } from "../proc.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "../proc.js";
import { sshBase, sshDestination, sshShell, shq, type RemoteHost } from "../remote/session-move.js";
import { HOST_PATH_EXPORT } from "../cloud/syncSide.js";
import { EXIT_INFRA } from "../infraExit.js";
import { hostRunnerSource, type HostInfoWire } from "./hostRunner.js";

/** How this side reaches a host: ssh in production, a local shell in tests. */
export interface Transport {
  label: string;
  /** Run a shell command on the host. */
  run(command: string, opts?: { input?: string | Buffer; timeoutMs?: number }): { status: number | null; signal?: string | null; stdout: Buffer; stderr: string };
  runAsync(command: string, opts?: { input?: string; timeoutMs?: number }): Promise<{ status: number | null; stdout: string; stderr: string }>;
  /** A long-running command whose stdout and stderr this side reads. */
  /** A long-running command; stdin stays open (and is the host side's sign that we are still here) until the child is killed. */
  stream(command: string): ChildProcess;
  /** Run a shell command on the host with its stdout written to `file` (large binary answers). */
  runToFile(command: string, input: string, file: string, timeoutMs?: number): { status: number | null; stderr: string };
  /** Where `git push` sends to, and the env it needs. */
  pushTarget(repo: string): { url: string; env: Record<string, string> };
}

export function sshTransport(host: RemoteHost, label = host.address): Transport {
  const base = [...sshBase(host), "-T", sshDestination(host)];
  return {
    label,
    run(command, opts = {}) {
      const r = spawnSync("ssh", [...base, command], { input: opts.input, timeout: opts.timeoutMs, maxBuffer: 1 << 30, env: process.env });
      return { status: r.status, signal: r.signal, stdout: (r.stdout as Buffer) ?? Buffer.alloc(0), stderr: String(r.stderr ?? (r.error ? r.error.message : "")) };
    },
    runAsync(command, opts = {}) {
      return collect(spawn("ssh", [...base, command], { stdio: ["pipe", "pipe", "pipe"], env: process.env }), opts);
    },
    stream(command) {
      const child = spawn("ssh", [...base, command], { stdio: ["pipe", "pipe", "pipe"], detached: true, env: process.env });
      child.stdin?.on("error", () => {});
      return child;
    },
    runToFile(command, input, file, timeoutMs) {
      const fd = fs.openSync(file, "w", 0o600);
      try {
        const r = spawnSync("ssh", [...base, command], { input, stdio: ["pipe", fd, "pipe"], timeout: timeoutMs, env: process.env });
        return { status: r.status, stderr: String(r.stderr ?? (r.error ? r.error.message : "")) };
      } finally { fs.closeSync(fd); }
    },
    pushTarget(repo) {
      return { url: `ssh://${sshDestination(host)}${repo}`, env: { GIT_SSH_COMMAND: sshShell(sshBase(host)) } };
    },
  };
}

/** A "host" that is a directory on this machine with its own HOME: tests and `--host local`. */
export function localTransport(home: string, label = "local"): Transport {
  const env = () => ({ ...process.env, HOME: home, CAST_RUN_ROOT: path.join(home, ".codecast", "run") });
  return {
    label,
    run(command, opts = {}) {
      const r = spawnSync("bash", ["-c", command], { input: opts.input, timeout: opts.timeoutMs, maxBuffer: 1 << 30, env: env() });
      return { status: r.status, signal: r.signal, stdout: (r.stdout as Buffer) ?? Buffer.alloc(0), stderr: String(r.stderr ?? "") };
    },
    runAsync(command, opts = {}) {
      return collect(spawn("bash", ["-c", command], { stdio: ["pipe", "pipe", "pipe"], env: env() }), opts);
    },
    stream(command) {
      const child = spawn("bash", ["-c", command], { stdio: ["pipe", "pipe", "pipe"], detached: true, env: env() });
      child.stdin?.on("error", () => {});
      return child;
    },
    runToFile(command, input, file, timeoutMs) {
      const fd = fs.openSync(file, "w", 0o600);
      try {
        const r = spawnSync("bash", ["-c", command], { input, stdio: ["pipe", fd, "pipe"], timeout: timeoutMs, env: env() });
        return { status: r.status, stderr: String(r.stderr ?? "") };
      } finally { fs.closeSync(fd); }
    },
    pushTarget(repo) {
      return { url: repo, env: {} };
    },
  };
}

export function collect(child: ChildProcess, opts: { input?: string; timeoutMs?: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs) : undefined;
    child.on("close", (status) => { if (timer) clearTimeout(timer); resolve({ status, stdout, stderr: timedOut ? `${stderr}\ngave no answer in ${Math.round(opts.timeoutMs! / 1000)}s` : stderr }); });
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ status: null, stdout, stderr: stderr || e.message }); });
  });
}

let cachedSource: { text: string; hash: string } | undefined;
export function runnerProgram(): { text: string; hash: string } {
  if (!cachedSource) {
    const text = hostRunnerSource();
    cachedSource = { text, hash: crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) };
  }
  return cachedSource;
}

/**
 * The shell line that runs one of the runner's commands on the host. With
 * `install` (the default) stdin carries the runner, written once per content
 * hash; without it stdin is the command's own input and the runner must
 * already be there (a `prep` in the same run put it there).
 */
export function runnerCommand(args: string[], opts: { install?: boolean } = {}): string {
  const { hash } = runnerProgram();
  return [
    HOST_PATH_EXPORT,
    `R="$HOME/.codecast/run/bin/runner-${hash}.js"`,
    opts.install === false
      ? `[ -s "$R" ] && touch "$R" || { echo "cast run host: runner missing" >&2; exit 71; }`
      // A runner cut off on the way (a probe timing out mid-send) must never be saved: its hash has to match before it is kept.
      : `if [ -s "$R" ]; then touch "$R"; cat >/dev/null; else mkdir -p "$HOME/.codecast/run/bin" && cat > "$R.$$" && H=$( (sha256sum "$R.$$" 2>/dev/null || shasum -a 256 "$R.$$") | cut -c1-16) && [ "$H" = "${hash}" ] && mv "$R.$$" "$R" || { rm -f "$R.$$"; echo "cast run host: the runner arrived incomplete" >&2; exit 71; }; fi`,
    `exec bun "$R" ${args.map(shq).join(" ")}`,
  ].join("; ");
}

export function callRunner(t: Transport, args: string[], timeoutMs = 60_000, input?: string): { status: number | null; signal?: string | null; stdout: Buffer; stderr: string } {
  return input === undefined
    ? t.run(runnerCommand(args), { input: runnerProgram().text, timeoutMs })
    : t.run(runnerCommand(args, { install: false }), { input, timeoutMs });
}

/** Async, so a Ctrl-C reaches this process's handlers the moment it lands instead of after the ssh returns. */
export async function runnerJsonAsync<T>(t: Transport, args: string[], timeoutMs = 60_000, input?: string): Promise<T> {
  const r = input === undefined
    ? await t.runAsync(runnerCommand(args), { input: runnerProgram().text, timeoutMs })
    : await t.runAsync(runnerCommand(args, { install: false }), { input, timeoutMs });
  // Only ssh's own 255 means the host was not reached; a slow answer we gave up on is not that.
  if (r.status !== 0) throw new InfraError(`host runner ${args[0]} failed on ${t.label}: ${lastLine(r.stderr) || `exit ${r.status}`}`, r.status === 255 ? "the host did not answer over ssh; check it with cast remote hosts" : undefined, EXIT_INFRA, r.status === 255);
  return JSON.parse(r.stdout.trim().split("\n").pop() || "null") as T;
}

export const lastLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

/** A failure of the tool, not the command: exits 70 (or `code`) with `hint` as the last line. */
export class InfraError extends Error {
  constructor(message: string, public hint?: string, public code = EXIT_INFRA, public unreachable = false) {
    super(message);
  }
}

/** One host's load, for picking where a run goes. Undefined when it does not answer. */
export async function probeHost(t: Transport, timeoutMs = 10_000): Promise<HostInfoWire | undefined> {
  return (await probeHostDetail(t, timeoutMs)).info;
}

/** A probe and, when it fails, why: no answer over ssh is not the same as an answer that is an error. */
export async function probeHostDetail(t: Transport, timeoutMs = 10_000): Promise<{ info?: HostInfoWire; error?: string; reached?: boolean }> {
  const r = await t.runAsync(runnerCommand(["info"]), { input: runnerProgram().text, timeoutMs });
  if (r.status !== 0) return { error: lastLine(r.stderr) || (r.status === null ? `no answer in ${timeoutMs / 1000}s` : `exit ${r.status}`), reached: r.status !== 255 && r.status !== null };
  try { return { info: JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as HostInfoWire }; } catch { return { error: "the runner answered with something that is not JSON", reached: true }; }
}

/**
 * The host with room for `needGb`: the one this repo last ran on while it has
 * room (its warm dependency tree and slots are there), else the least load per
 * core. Undefined when none has room.
 */
export function pickHost<T extends { id: string }>(cands: Array<{ host: T; info: HostInfoWire }>, needGb: number, preferId?: string): { host: T; info: HostInfoWire } | undefined {
  // Room is memory, a free slot and disk: a full disk answers probes fine and then fails every run.
  const fits = cands.filter((c) => c.info.memAvailGb - needGb >= 1 && c.info.active < c.info.slots && (c.info.diskFreeGb === undefined || c.info.diskFreeGb >= 5));
  const sticky = preferId ? fits.find((c) => c.host.id === preferId && c.info.load1 / c.info.cpus < 1.5) : undefined;
  if (sticky) return sticky;
  return fits.sort((a, b) => a.info.load1 / a.info.cpus - b.info.load1 / b.info.cpus || b.info.memAvailGb - a.info.memAvailGb)[0];
}

/** Exit once everything written has reached the pipe: bun drops a pipe's unflushed bytes at process.exit. */
export async function flushAndExit(code: number): Promise<never> {
  // end()'s callback is the one that waits for bun to hand every byte to the pipe; a 10 MB log once arrived as its first 64 KB.
  const ended = Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.end(() => resolve()))));
  await Promise.race([ended, new Promise((r) => setTimeout(r, 60_000).unref())]);
  process.exit(code);
}
