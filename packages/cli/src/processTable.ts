// One `ps` snapshot of the whole process table, plus the pure tree walks built
// on it: descendants of a pid, and the "stale tmux server generation" detector
// that `cast doctor` runs.
//
// Why stale generations matter: when the default tmux socket file is replaced
// (the server wedged and a client unlinked it, /tmp was swept, a crashed
// respawn), the old server keeps running unreachable and holds every pane and
// agent process of its generation. `tmux list-sessions` only talks to the
// socket's current owner, so the fleet is invisible — and the daemon re-resumes
// the same session ids on the new server, doubling every agent. Seen twice
// (2026-08-14: 165 orphan claudes / 56GB; 2026-08-20: 290 processes, 10 orphan
// teammates / 5GB plus 267 idle login shells pushing `ps aux` past 20s).

import { execFileSync, spawnSync } from "./proc.js";
import { isRecognizedAgentComm } from "./sessionProcessMatcher.js";
import { CLAUDE_VERSIONED_BINARY_RE } from "./stableClaudeBinary.js";

export type ProcRow = { pid: number; ppid: number; command: string };

// `ps -o command` prints a multi-line command line with its newlines intact,
// so a row can span lines: a line that does not start with a pid continues
// the previous row's command.
export function parseProcessTable(stdout: string): ProcRow[] {
  const procs: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) {
      procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
    } else if (procs.length && line.length) {
      procs[procs.length - 1].command += "\n" + line;
    }
  }
  return procs;
}

/** The live process table (pid, ppid, full command line). Empty on failure. */
export function snapshotProcessTable(): ProcRow[] {
  try {
    return parseProcessTable(
      execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
      }) as string,
    );
  } catch {
    return [];
  }
}

/** Every transitive child of `root` (root excluded), parents before children. */
export function descendantPids(procs: ProcRow[], root: number): number[] {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Does a command line's program look like one of our agent clients? Matches the
 *  registry binary names and the claude launcher's versioned binaries
 *  (`~/.local/share/claude/versions/2.1.237`), whose basename is a version. */
export function isAgentCommand(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  if (CLAUDE_VERSIONED_BINARY_RE.test(argv0)) return true;
  const base = argv0.split("/").pop() ?? "";
  // interpreters (node/bun) are too generic for a whole-tree count
  if (/^(node|bun|deno)$/.test(base)) return false;
  return isRecognizedAgentComm(base);
}

/** Program names that can be argv0 of a daemon. Anything else naming `_daemon`
 *  or a daemon file is talking ABOUT the daemon, not running it. */
const DAEMON_ARGV0_RE = /^(codecast|cast|bun|node|deno)(\.exe)?$/;

/**
 * Is this command line a codecast daemon? Matches all three install shapes:
 * source (`bun .../packages/cli/src/daemon.ts _daemon`), built JS
 * (`node .../dist/daemon.js`) and the compiled binary (`codecast -- _daemon`).
 *
 * Two tests keep the neighbours out, and both are load bearing because the
 * split brain sweep KILLS what this matches. The program has to be one of ours
 * or an interpreter, which rejects `nginx: master ... -g daemon off;`. And the
 * daemon token has to sit in the first argument position, which rejects every
 * cast command that merely mentions it: `cast send jx7c6zk restart the _daemon
 * now` and `cast blame packages/cli/src/daemon.ts` are ordinary commands, and
 * ps flattens quoting so a message body is just more argv tokens.
 *
 * It also deliberately misses `codecast _watchdog` and the worker shape
 * `codecast _worker <kind>`: those are meant to live.
 */
export function isDaemonCommand(command: string): boolean {
  const argv = command.trim().split(/\s+/).filter((t) => t.length > 0);
  if (argv.length < 2) return false;
  const argv0 = argv[0].split("/").pop() ?? "";
  if (!DAEMON_ARGV0_RE.test(argv0)) return false;
  // Interpreter flags (`bun --smol`, `node --enable-source-maps`) and the
  // argument separator sit before the entry point; nothing else may.
  const first = argv.slice(1).find((t) => t !== "--" && !t.startsWith("-"));
  if (!first) return false;
  return first === "_daemon" || first.endsWith("/daemon.ts") || first.endsWith("/daemon.js");
}

/** Pids of every other daemon process on this machine. */
export function findOtherDaemonPids(procs: ProcRow[], selfPid = process.pid): number[] {
  return procs.filter((p) => p.pid !== selfPid && isDaemonCommand(p.command)).map((p) => p.pid);
}

export interface StaleTmuxServer {
  pid: number;
  command: string;
  /** Processes in its tree, the server excluded. */
  descendants: number;
  /** How many of those are agent processes (claude, codex, ...). */
  agents: number;
}

/** tmux SERVER processes on the default socket: daemonized (ppid 1) `tmux`
 *  rows not pinned to another socket with -L/-S. Clients attached from a shell
 *  keep their shell as parent and never match. */
export function tmuxServerRows(procs: ProcRow[]): ProcRow[] {
  return procs.filter((p) => {
    if (p.ppid !== 1) return false;
    const argv = p.command.trim().split(/\s+/);
    const base = argv[0]?.split("/").pop();
    if (base !== "tmux") return false;
    return !argv.some((a, i) => i > 0 && (a === "-L" || a === "-S" || a.startsWith("-L") || a.startsWith("-S")));
  });
}

/** Servers on the default socket other than the one tmux itself answers from.
 *  `livePid` null (tmux unreachable) reports every server, since none can be
 *  the live one. */
export function findStaleTmuxServers(procs: ProcRow[], livePid: number | null): StaleTmuxServer[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return tmuxServerRows(procs)
    .filter((s) => s.pid !== livePid)
    .map((s) => {
      const tree = descendantPids(procs, s.pid);
      const agents = tree.filter((pid) => isAgentCommand(byPid.get(pid)?.command ?? "")).length;
      return { pid: s.pid, command: s.command, descendants: tree.length, agents };
    });
}

/** The pid of the tmux server behind the default socket, or null when tmux is
 *  not installed or no server is running. */
export function liveTmuxServerPid(): number | null {
  const r = spawnSync("tmux", ["display-message", "-p", "#{pid}"], { encoding: "utf-8", timeout: 10_000 });
  const pid = parseInt(String(r.stdout ?? "").trim(), 10);
  return r.status === 0 && Number.isFinite(pid) && pid > 0 ? pid : null;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** SIGTERM every pid, wait up to `graceMs`, SIGKILL the survivors. Killing a
 *  tmux server alone leaks its tree, so callers pass the server AND its
 *  descendants. Returns how many needed the hard kill. */
export async function killProcessTree(pids: number[], graceMs = 3_000): Promise<{ terminated: number; killed: number }> {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + graceMs;
  let survivors = pids.filter(isAlive);
  while (survivors.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    survivors = survivors.filter(isAlive);
  }
  for (const pid of survivors) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  return { terminated: pids.length - survivors.length, killed: survivors.length };
}
