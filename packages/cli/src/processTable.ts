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

import { execFileAsync, execFileSync } from "./proc.js";
import { isRecognizedAgentComm } from "./sessionProcessMatcher.js";
import { tmuxRunAsync } from "./tmux.js";
import { CLAUDE_VERSIONED_BINARY_RE } from "./stableClaudeBinary.js";

/** One process, as `ps` reported it.
 *
 *  `uid` is the owning user, absent when the table was parsed from output that
 *  did not carry the column. A kill decision treats absent as "not mine".
 *
 *  `pgid`, `startedAt` and `capturedAtMs` are the process IDENTITY, and they are
 *  what makes a delayed SIGKILL safe: a pid alone is a slot the kernel reuses,
 *  so a pid observed before a grace window and found alive after it may be a
 *  different program by then. All three are absent when the table came from
 *  output without those columns, and every identity check fails closed on
 *  absence — no proof, no hard kill. */
export type ProcRow = {
  pid: number;
  ppid: number;
  uid?: number;
  /** Process group id. Part of the identity because a survivor that kept its
   *  pid but joined a new group is a different process. */
  pgid?: number;
  /** `ps lstart` with runs of spaces collapsed ("Tue Aug 25 05:04:18 2026").
   *  Compared verbatim, so a locale-dependent parse never decides a kill. */
  startedAt?: string;
  /** Wall clock taken BEFORE the `ps` that produced this row started. A later
   *  stamp would make a pid born during the scan look older than the capture
   *  and defeat the capture-second rule below. */
  capturedAtMs?: number;
  command: string;
};

// `ps -o lstart=` is five space-separated fields of fixed shape, and it is the
// only column between the numbers and the command line that is not itself a
// number, so it anchors the wide form unambiguously.
const LSTART_RE = "[A-Za-z]{3}\\s+[A-Za-z]{3}\\s+\\d{1,2}\\s+\\d{1,2}:\\d{2}:\\d{2}\\s+\\d{4}";
const WITH_IDENTITY = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(-?\\d+)\\s+(${LSTART_RE})\\s+(\\S.*)$`);

// `ps -o command` prints a multi-line command line with its newlines intact,
// so a row can span lines: a line that does not start with a pid continues
// the previous row's command.
//
// Three shapes are accepted, `pid ppid pgid uid lstart command`, `pid ppid uid
// command` and `pid ppid command`, so a caller that already holds a narrower
// table keeps working. The widest form is tried first: its four leading numbers
// followed by a date would otherwise be read as `pid ppid uid` plus a command
// line beginning with a number and a weekday.
export function parseProcessTable(stdout: string, capturedAtMs?: number): ProcRow[] {
  const procs: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    // macOS prints the uid of a `nobody` process as -2, so the owner column is
    // signed. Without the sign those rows fell through to the two number shape
    // and carried "-2" into the command text.
    const wide = WITH_IDENTITY.exec(line);
    if (wide) {
      procs.push({
        pid: Number(wide[1]),
        ppid: Number(wide[2]),
        pgid: Number(wide[3]),
        uid: Number(wide[4]),
        // ps pads the day of month, so the same instant can print with one or
        // two inner spaces; collapse them or a re-read would never match.
        startedAt: wide[5].replace(/\s+/g, " "),
        capturedAtMs,
        command: wide[6],
      });
      continue;
    }
    const withUid = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S.*)$/);
    const m = withUid ?? line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) {
      procs.push(
        withUid
          ? { pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), command: m[4] }
          : { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] },
      );
    } else if (procs.length && line.length) {
      procs[procs.length - 1].command += "\n" + line;
    }
  }
  return procs;
}

// The owner column rides along because the daemon's hourly sweep kills stale
// tmux servers unattended, and on a shared box (the EC2 Mac mini, the Linux
// agent hosts) another user's server on the default socket is not ours to touch.
// pgid and lstart ride along because killProcessTree escalates to SIGKILL after
// a grace window, and by then a pid is only evidence when its start time and
// process group still agree (ct-49537).
const PS_ARGS = ["-axww", "-o", "pid=,ppid=,pgid=,uid=,lstart=,command="];
// LC_ALL=C because lstart is localized: two captures under different locales
// would print the same instant differently and never compare equal.
const PS_OPTS = {
  encoding: "utf-8" as const,
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, LANG: "C", LC_ALL: "C" },
};

/** How long to wait for `ps`. The default is generous because a doctor sweep
 *  would rather wait than miss an orphan fleet; on this laptop `ps aux` has run
 *  to 26s under load. An interactive caller passes something shorter: an empty
 *  table costs it one sweep, a stall costs the user the whole command. */
const PS_TIMEOUT_MS = 30_000;

export interface ProcessTableOptions {
  /** Milliseconds before `ps` is abandoned and the table comes back empty. */
  timeout?: number;
}

/** The live process table (pid, ppid, full command line). Empty on failure. */
export function snapshotProcessTable(opts: ProcessTableOptions = {}): ProcRow[] {
  // Stamped before the spawn: the capture second a row is judged against must
  // never be later than the scan that produced it.
  const capturedAtMs = Date.now();
  try {
    return parseProcessTable(
      execFileSync("ps", PS_ARGS, { ...PS_OPTS, timeout: opts.timeout ?? PS_TIMEOUT_MS }) as string,
      capturedAtMs,
    );
  } catch {
    return [];
  }
}

/** The same snapshot off the event loop. The daemon uses this one: a `ps` that
 *  runs for seconds under load must never be the thing holding the loop. */
export async function snapshotProcessTableAsync(opts: ProcessTableOptions = {}): Promise<ProcRow[]> {
  const capturedAtMs = Date.now();
  try {
    const { stdout } = await execFileAsync("ps", PS_ARGS, {
      ...PS_OPTS,
      timeout: opts.timeout ?? PS_TIMEOUT_MS,
    });
    return parseProcessTable(String(stdout), capturedAtMs);
  } catch {
    return [];
  }
}

/**
 * Every transitive child of `root` (root excluded), parents before children.
 *
 * A root that is absent from the table, or present twice, yields nothing. A ppid
 * walk only means something while the root is alive in the same snapshot: once
 * it exits its real children reparent to pid 1 and leave the walk, so rows still
 * pointing at the vacated pid are a pid-reuse coincidence and signalling them
 * would hit a stranger's tree.
 */
export function descendantRows(procs: ProcRow[], root: number): ProcRow[] {
  const children = new Map<number, ProcRow[]>();
  let rootRow: ProcRow | undefined;
  let duplicateRoot = false;
  for (const p of procs) {
    if (p.pid === root) {
      duplicateRoot ||= rootRow !== undefined;
      rootRow ??= p;
    }
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  if (!rootRow || duplicateRoot) return [];
  const out: ProcRow[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
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
  // Interpreter flags (`bun --smol`, `node --enable-source-maps`), the argument
  // separator, and bun's own `run` subcommand sit before the entry point;
  // nothing else may. `bun run x/daemon.ts` executes the file in this process,
  // so it is a daemon like any other shape.
  const rest = /^(bun|deno)(\.exe)?$/.test(argv0) && argv[1] === "run" ? argv.slice(2) : argv.slice(1);
  const first = rest.find((t) => t !== "--" && !t.startsWith("-"));
  if (!first) return false;
  return first === "_daemon" || first.endsWith("/daemon.ts") || first.endsWith("/daemon.js");
}

/** Every other daemon process on this machine, as the rows it was seen in — a
 *  killer needs the identity, not just the slot number. */
export function findOtherDaemonRows(procs: ProcRow[], selfPid = process.pid): ProcRow[] {
  return procs.filter((p) => p.pid !== selfPid && isDaemonCommand(p.command));
}

/** The same list, as pids, for callers that only probe or signal once. */
export function findOtherDaemonPids(procs: ProcRow[], selfPid = process.pid): number[] {
  return findOtherDaemonRows(procs, selfPid).map((p) => p.pid);
}

export interface StaleTmuxServer {
  pid: number;
  command: string;
  /** The server's own row, so a caller can hand the whole generation to
   *  killProcessTree with the identity it was observed under. */
  row: ProcRow;
  /** Every process in its tree, the server excluded. The killer takes this
   *  list as it is: walking the table a second time to rebuild it can only
   *  disagree with the list the agent count was derived from, and it would
   *  drop the capture identity a delayed SIGKILL is judged against. */
  tree: ProcRow[];
  /** How many of those are agent processes (claude, codex, ...). */
  agents: number;
  /** The table holds this pid more than once, so `tree` is empty for want of a
   *  root to walk from rather than because the server holds nothing. */
  ambiguous: boolean;
}

/** tmux SERVER processes on the default socket: daemonized (ppid 1) `tmux`
 *  rows not pinned to another socket with -L/-S. Clients attached from a shell
 *  keep their shell as parent and never match.
 *
 *  `ownerUid` keeps another user's server out of the list, and every caller that
 *  can end in a kill passes it. A row with no owner column is dropped by it too:
 *  a killer must fail closed. Omitting it reports every server on the socket. */
export function tmuxServerRows(procs: ProcRow[], ownerUid?: number): ProcRow[] {
  return procs.filter((p) => {
    if (p.ppid !== 1) return false;
    if (ownerUid !== undefined && p.uid !== ownerUid) return false;
    const argv = p.command.trim().split(/\s+/);
    const base = argv[0]?.split("/").pop();
    if (base !== "tmux") return false;
    return !argv.some((a, i) => i > 0 && (a === "-L" || a === "-S" || a.startsWith("-L") || a.startsWith("-S")));
  });
}

/** Servers on the default socket other than the one tmux itself answers from.
 *  `livePid` null (tmux unreachable) reports every server, since none can be
 *  the live one. */
export function findStaleTmuxServers(procs: ProcRow[], livePid: number | null, ownerUid?: number): StaleTmuxServer[] {
  return tmuxServerRows(procs, ownerUid)
    .filter((s) => s.pid !== livePid)
    .map((s) => {
      const tree = descendantRows(procs, s.pid);
      const agents = tree.filter((p) => isAgentCommand(p.command)).length;
      const ambiguous = procs.filter((p) => p.pid === s.pid).length > 1;
      return { pid: s.pid, command: s.command, row: s, tree, agents, ambiguous };
    });
}

/**
 * What the daemon's unattended sweep may kill.
 *
 * Three guards, all here so they can be tested without a process table or a
 * tmux.
 *
 * No live pid means no kills at all: findStaleTmuxServers reports EVERY server
 * when it cannot name the live one, because none of them can be it, so a tmux
 * that is briefly unreachable would otherwise take the entire fleet down.
 *
 * Only this user's servers are candidates, because on a shared agent box
 * another account's server is neither stale nor ours.
 *
 * And a server whose tree holds this process is refused outright. A daemon
 * started from inside a tmux pane, which is the ordinary from-source shape,
 * would otherwise kill itself and its watchdog on an hourly tick the moment its
 * own generation went stale. The whole tree goes with the server, so dropping
 * one pid from the list is not enough: the parent shell dies and takes this
 * process with it. Reported separately so the sweep can say what it spared.
 */
export function staleTmuxServerKillPlan(
  procs: ProcRow[],
  livePid: number | null,
  ownerUid?: number,
  selfPid: number = process.pid,
): { kill: StaleTmuxServer[]; selfHosted: StaleTmuxServer[]; refused: "tmux-unreachable" | null } {
  if (livePid === null) return { kill: [], selfHosted: [], refused: "tmux-unreachable" };
  const kill: StaleTmuxServer[] = [];
  const selfHosted: StaleTmuxServer[] = [];
  for (const server of findStaleTmuxServers(procs, livePid, ownerUid)) {
    // An ambiguous server is spared for the same reason a self-hosting one is:
    // its tree walk returned nothing, so the table cannot say what it holds,
    // and "holds nothing" and "holds this daemon" look identical from here.
    if (server.ambiguous || server.pid === selfPid || server.tree.some((p) => p.pid === selfPid)) selfHosted.push(server);
    else kill.push(server);
  }
  return { kill, selfHosted, refused: null };
}

/** The pid of the tmux server behind the default socket, or null when tmux is
 *  not installed or no server is running.
 *
 *  Async because the daemon's hourly stale-generation sweep asks for it on the
 *  main event loop, where a tmux that takes seconds to answer would block every
 *  session's delivery. Through tmuxRunAsync, not a bare execFileAsync, because
 *  that is the call that enriches PATH: under launchd the daemon's PATH has no
 *  /opt/homebrew/bin, so a bare `tmux` is simply not found and every server
 *  reads stale. */
export async function liveTmuxServerPid(): Promise<number | null> {
  const { status, stdout } = await tmuxRunAsync(["display-message", "-p", "#{pid}"], { timeout: 10_000 });
  const pid = parseInt(String(stdout ?? "").trim(), 10);
  return status === 0 && Number.isFinite(pid) && pid > 0 ? pid : null;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** How long a process gets to honour SIGTERM before the identity check and the
 *  hard kill. Long enough for an agent to flush, short enough that a teardown
 *  request answers. */
export const KILL_GRACE_MS = 2_000;

/**
 * Was this row's start time recorded early enough to identify it later?
 *
 * `ps lstart` has one second resolution, so a process born inside the second
 * the table was captured shares its printed start time with anything the kernel
 * could put in that pid slot during the same second. Such a row is never
 * escalated: it is exactly the case where a pid that looks alive after the
 * grace window may be a different program.
 */
export function bornBeforeCaptureSecond(row: ProcRow): boolean {
  if (!row.startedAt || row.capturedAtMs === undefined) return false;
  const startedAtMs = Date.parse(row.startedAt);
  if (!Number.isFinite(startedAtMs)) return false;
  return startedAtMs < Math.floor(row.capturedAtMs / 1_000) * 1_000;
}

/**
 * Is the process at `snapshot.pid` right now still the one we snapshotted?
 *
 * Pid, start time and process group must all agree, and the snapshot's start
 * time must be older than its capture second. Anything missing fails closed:
 * a table without the identity columns cannot license a SIGKILL.
 */
export function sameProcess(snapshot: ProcRow, live: ProcRow | null | undefined): boolean {
  if (!live || live.pid !== snapshot.pid) return false;
  if (!snapshot.startedAt || snapshot.startedAt !== live.startedAt) return false;
  if (snapshot.pgid === undefined || snapshot.pgid !== live.pgid) return false;
  return bornBeforeCaptureSecond(snapshot);
}

export interface KillTreeResult {
  /** Signalled processes that were gone by the end of the grace window. */
  terminated: number;
  /** Survivors that proved their identity and took a SIGKILL. */
  killed: number;
  /** Survivors left running because the table could not prove they are still
   *  the process we signalled. Nonzero here is a leak, not a failure to try. */
  unverified: number;
}

/**
 * SIGTERM a snapshotted set of processes, wait out the grace window, then
 * SIGKILL only the survivors the process table still identifies as the same
 * processes.
 *
 * Callers pass ROWS, not pids, and pass them from ONE table read taken before
 * the first signal. That is the whole point: a pid is a slot the kernel reuses,
 * and between the SIGTERM and the SIGKILL there is a window in which the pid we
 * are about to hard kill can belong to somebody else. The row carries the start
 * time, the process group and the capture instant that make the second signal
 * provably aimed at the first signal's target (ct-49537).
 *
 * Killing a tmux server or an agent alone leaks its tree, so callers pass the
 * root AND its descendants, descendants first.
 */
export async function killProcessTree(
  targets: ProcRow[],
  graceMs = KILL_GRACE_MS,
  deps: {
    readTable?: () => Promise<ProcRow[]>;
    sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
    isAlive?: (pid: number) => boolean;
  } = {},
): Promise<KillTreeResult> {
  const readTable = deps.readTable ?? (() => snapshotProcessTableAsync({ timeout: 10_000 }));
  const alive = deps.isAlive ?? isAlive;
  const sendSignal = deps.sendSignal ?? ((pid, signal) => { try { process.kill(pid, signal); } catch {} });

  // Never signal this process or an init-like pid, whatever a caller hands over.
  const signalled = targets.filter((t) => Number.isInteger(t.pid) && t.pid > 1 && t.pid !== process.pid);
  for (const t of signalled) sendSignal(t.pid, "SIGTERM");
  if (signalled.length === 0) return { terminated: 0, killed: 0, unverified: 0 };

  // Poll rather than sleep the whole window: the common case is a tree that
  // dies at once, and a caller waiting on teardown should not pay 2s for it.
  // Every wait is a timer, so the daemon's loop keeps running through it.
  const deadline = Date.now() + graceMs;
  let survivors = signalled.filter((t) => alive(t.pid));
  while (survivors.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    survivors = survivors.filter((t) => alive(t.pid));
  }
  if (survivors.length === 0) return { terminated: signalled.length, killed: 0, unverified: 0 };

  // `process.kill(pid, 0)` above says the slot is occupied, not by whom. Only a
  // fresh table answers that, and only for the few pids still standing.
  const wanted = new Set(survivors.map((t) => t.pid));
  const live = new Map<number, ProcRow | null>();
  for (const row of await readTable()) {
    if (!wanted.has(row.pid)) continue;
    // Two rows for one pid in a non-atomic read leave no safe identity.
    live.set(row.pid, live.has(row.pid) ? null : row);
  }
  let killed = 0;
  let unverified = 0;
  for (const t of survivors) {
    const now = live.get(t.pid);
    // Absent from the fresh table: it exited between the last poll and the read.
    if (now === undefined) continue;
    if (!sameProcess(t, now)) { unverified++; continue; }
    sendSignal(t.pid, "SIGKILL");
    killed++;
  }
  return { terminated: signalled.length - killed - unverified, killed, unverified };
}
