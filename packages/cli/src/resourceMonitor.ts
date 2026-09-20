import { execFileAsync } from "./proc.js";
import { shortId } from "./sessionProcessMatcher.js";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  cpu: number;
  rss: number;
  /** Wall-clock start, derived from ps `etime` at snapshot time. Identifies the
   *  process GENERATION: a restarted agent keeps its session id and often its
   *  place in the tree, but never its start time. */
  startedAt?: number;
}

/** ps `etime` — elapsed wall time as `[[dd-]hh:]mm:ss` — in seconds. One
 *  whitespace-free token, unlike `lstart`, so it survives the column split the
 *  snapshot parser does. Returns undefined for anything unparseable rather
 *  than guessing: a wrong start time would fence live work as dead. */
/** ps reports elapsed time in whole seconds, so every tick recomputes the start
 *  as `now - floor(elapsed)` and lands up to a second away from the last
 *  sample. Left alone that jitter reads as a restart on each tick — which would
 *  patch the hot managed_sessions doc every 30s per session and re-push the
 *  liveness overlay with a value that never settles. Hold the previous reading
 *  unless the new one moves further than sampling error ever could; a real
 *  restart moves it by minutes. */
export const AGENT_START_JITTER_MS = 5_000;
export function stableAgentStartedAt(cur: number | undefined, prev: number | undefined): number | undefined {
  // No reading this tick: claim nothing rather than re-assert a stale start.
  if (cur === undefined) return undefined;
  if (prev === undefined) return cur;
  return Math.abs(cur - prev) <= AGENT_START_JITTER_MS ? prev : cur;
}

export function parseEtimeSeconds(etime: string): number | undefined {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return undefined;
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map((p) => (p === undefined ? 0 : parseInt(p, 10)));
  if ([days, hours, minutes, seconds].some(isNaN)) return undefined;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

export interface SessionResources {
  sessionId: string;
  cpu: number;
  memory: number;
  pidCount: number;
  collectedAt: number;
  /** When this session's agent process started. The web fences background
   *  watches against it: a watch armed before the current process booted was a
   *  child of a process that no longer exists, so it is dead however recently
   *  the session itself was active. */
  agentStartedAt?: number;
  /** This session's root pid belongs to ANOTHER session, which was credited with
   *  the subtree instead. cpu/memory/pidCount are zero so a fleet total counts
   *  each process tree exactly once; the session still reports, so it keeps a
   *  liveness signal rather than going dark. */
  sharesRootPid?: boolean;
}

// Below this CPU% (and not in a working status) a tick counts as idle.
export const IDLE_CPU_FLOOR_PCT = 2;
const WORKING_STATUSES = new Set(["working", "thinking", "compacting", "starting", "resuming"]);

// The agent's own word that a turn is underway. This is the only signal that
// restarts the idle clock: see nextAwakeIdleMs.
export function isWorkingStatus(status: string | undefined): boolean {
  return status !== undefined && WORKING_STATUSES.has(status);
}

// A session is "active" this tick if it's burning CPU or its agent_status is a
// working state. Gates the metrics report, so a burst of CPU on a resting
// session still reaches the web promptly.
export function isSessionActive(cpu: number, status: string | undefined): boolean {
  return cpu >= IDLE_CPU_FLOOR_PCT || isWorkingStatus(status);
}

// Idle sessions' metrics are flat, but the old code reported every session every
// tick — one session_metrics insert (+ a cleanup scan) per session per 30s. With
// a fleet of ~100 mostly-idle sessions that burst saturates the daemon's socket
// pool and starves message-sync mutations (they hang to their 60s timeout). Cap
// how often an idle/unchanged session re-reports so per-tick write volume tracks
// the number of ACTIVE sessions, not the total.
export const IDLE_METRICS_REFRESH_MS = 3 * 60 * 1000;
const METRICS_MEM_DELTA_FRAC = 0.1; // a ≥10% memory move is worth reporting

export interface ReportedMetrics {
  cpu: number;
  memory: number;
  pidCount: number;
  agentPid?: number;
  agentStartedAt?: number;
  at: number;
}

/**
 * Decide whether a metrics report is worth sending given the last one sent for
 * this session. Active sessions always report (full-fidelity graphs); idle ones
 * report only on a meaningful change (cpu, pid count, process-tree shape, a
 * memory swing, or an agent_pid change the server's snapshot patch needs) or a
 * slow keep-alive so the graph/liveness never goes stale.
 */
export function shouldReportMetrics(args: {
  cur: { cpu: number; memory: number; pidCount: number; agentPid?: number; agentStartedAt?: number };
  prev: ReportedMetrics | undefined;
  status: string | undefined;
  now: number;
}): boolean {
  const { cur, prev, status, now } = args;
  if (!prev) return true; // never reported
  if (isSessionActive(cur.cpu, status)) return true; // working or burning CPU
  if (cur.agentPid !== prev.agentPid) return true; // feeds the server snapshot patch
  // A restart is exactly the moment the web needs to hear about, and it can
  // land on an idle session the throttle would otherwise sit on for minutes —
  // during which the inbox still shows the dead process's watches as running.
  // Checked separately from agentPid because the OS can reuse a pid.
  if (cur.agentStartedAt !== prev.agentStartedAt) return true;
  if (cur.pidCount !== prev.pidCount) return true; // process tree changed
  if (Math.abs(cur.memory - prev.memory) >= prev.memory * METRICS_MEM_DELTA_FRAC) return true;
  return now - prev.at >= IDLE_METRICS_REFRESH_MS; // otherwise a slow keep-alive
}

/**
 * Per-tick update of a session's awake-idle counter.
 *
 * Returns the new accumulated idle time. The counter measures idle time only
 * while the machine is AWAKE: a `sleepSkip` tick (first tick, wake grace, or an
 * oversized gap from suspend/stall) carries the previous value forward unchanged,
 * so a closed-lid period never inflates idle time. A working status resets the
 * counter to 0: the agent says a turn is underway, so whatever idle it had
 * banked is over.
 *
 * CPU at or above the floor on a resting status only PAUSES the counter. It is
 * not a reset, because a resting Claude Code process crosses 2% on its own
 * often enough (hooks, status line, transcript writes, a loaded machine
 * inflating every wake) that a reset never let any session bank eight hours:
 * on 2026-09-19 five of a hundred panes silent for over eight hours read 2%+
 * at a single instant, and over the 960 ticks in eight hours that reset every
 * one of them, so an 8h hibernate_idle_ms parked nothing in 246 passes. A
 * pause keeps the tick out of the total without discarding what came before,
 * and a session doing real work announces it through its status.
 *
 * `sharesRootPid` is the same carry-forward, for a different lie: that session's
 * cpu is 0 because its subtree was credited to the session that OWNS the pid, not
 * because it is idle. Accruing on it would march the counter past the threshold
 * the Sessions page buckets as "idle" and offers up to bulk kill — a kill
 * candidate manufactured from a number we zeroed ourselves. Checked AFTER the
 * activity test on purpose: a borrower whose agent_status says it's working must
 * still reset to 0 rather than carry a stale total forward.
 */
export function nextAwakeIdleMs(params: {
  prevIdleMs: number;
  cpu: number;
  status: string | undefined;
  elapsedMs: number;
  sleepSkip: boolean;
  sharesRootPid?: boolean;
}): number {
  if (isWorkingStatus(params.status)) return 0;
  if (params.sharesRootPid || params.sleepSkip || params.cpu >= IDLE_CPU_FLOOR_PCT) return params.prevIdleMs;
  return params.prevIdleMs + params.elapsedMs;
}

// The idle clock outlives the daemon that kept it. The counters live in daemon
// memory, and this daemon restarts several times on a working day (eleven boots
// on 2026-09-18), so a clock that starts at zero on every boot never reaches an
// eight hour hibernate_idle_ms. The daemon writes the counters after each tick
// and the next boot reads them back. The gap between the two daemons is not
// counted, the same carry-forward a sleep gap gets.
//
// Whether a counter may be restored is decided by ACTIVITY, not by the age of
// the snapshot: a session whose transcript changed after the snapshot was
// written did something in the gap, and its banked idle is gone; one whose
// transcript did not change was as idle as the snapshot says, however long the
// gap. An age rule cannot tell those apart, and the first one (fifteen
// minutes) threw the whole fleet's counters away every morning: the laptop
// sleeps overnight, the daemon's last snapshot is seventeen hours old at wake,
// and nothing had happened to any session in between (2026-09-20).
// The age bound that remains is a sanity limit against a stray file.
export const AWAKE_IDLE_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 3600_000;
// How long a restored counter waits for its session to show up in a tick. The
// first ticks after boot see only part of the fleet (the process cache fills
// over the following seconds), and pruning "sessions not in this tick" on those
// ticks would throw away most of what was restored, then write a snapshot
// without it: on 2026-09-19 the first tick saw 56 of 96 sessions and three
// boots in fifteen minutes erased the clock that way.
export const AWAKE_IDLE_RESTORE_CLAIM_MS = 15 * 60 * 1000;

export type AwakeIdleSnapshot = { at: number; idle: Map<string, number> };

/** The snapshot's counters, or null when it is unreadable, from the future, or past the sanity bound. */
export function decodeAwakeIdleSnapshot(raw: string, now: number): AwakeIdleSnapshot | null {
  try {
    const snap = JSON.parse(raw) as { at?: unknown; idle?: unknown };
    if (typeof snap.at !== "number" || now - snap.at > AWAKE_IDLE_SNAPSHOT_MAX_AGE_MS || now < snap.at) return null;
    const idle = new Map<string, number>();
    for (const [sessionId, ms] of Object.entries((snap.idle ?? {}) as Record<string, unknown>)) {
      if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) idle.set(sessionId, ms);
    }
    return { at: snap.at, idle };
  } catch {
    return null;
  }
}

/**
 * The counters a snapshot may hand to the next daemon, given when each session
 * last wrote its transcript. A session that wrote after the snapshot was
 * active in the gap and starts from zero; a session whose activity is unknown
 * (no transcript found, or a store whose file is shared) starts from zero too,
 * because an unknown stretch must not be presented as idle.
 */
export function restorableAwakeIdle(
  snapshot: AwakeIdleSnapshot,
  lastActivityAt: ReadonlyMap<string, number | undefined>,
): Map<string, number> {
  const kept = new Map<string, number>();
  for (const [sessionId, ms] of snapshot.idle) {
    const activeAt = lastActivityAt.get(sessionId);
    if (activeAt !== undefined && activeAt <= snapshot.at) kept.set(sessionId, ms);
  }
  return kept;
}

/**
 * The per-session awake-idle counters, with the restore across a daemon boot.
 * A restored counter is held apart from the live ones until its session shows
 * up in a tick, stays in the snapshot meanwhile so a chain of quick restarts
 * cannot lose it, and expires with the claim window if no tick ever claims it.
 */
export class AwakeIdleClock {
  private readonly live = new Map<string, number>();
  private restored = new Map<string, number>();
  private restoredUntil = 0;

  /** Adopt the counters the previous daemon left that restorableAwakeIdle let through. */
  restore(idle: ReadonlyMap<string, number>, now: number): void {
    this.restored = new Map(idle);
    this.restoredUntil = now + AWAKE_IDLE_RESTORE_CLAIM_MS;
  }

  /** The counter a tick continues from: live, else restored and still inside the window, else 0. */
  previous(sessionId: string, now: number): number {
    const live = this.live.get(sessionId);
    if (live !== undefined) return live;
    return now < this.restoredUntil ? this.restored.get(sessionId) ?? 0 : 0;
  }

  set(sessionId: string, ms: number): void {
    this.live.set(sessionId, ms);
    this.restored.delete(sessionId);
  }

  /** What the rest of the daemon reads: only sessions a tick has seen. */
  get(sessionId: string): number {
    return this.live.get(sessionId) ?? 0;
  }

  /** Drop live counters for sessions this tick did not collect; expire the claim window. */
  prune(collected: ReadonlySet<string>, now: number): void {
    for (const sessionId of this.live.keys()) {
      if (!collected.has(sessionId)) this.live.delete(sessionId);
    }
    if (now >= this.restoredUntil) this.restored.clear();
  }

  /** The snapshot for the next daemon: live counters plus restored ones still waiting to be claimed. */
  encode(now: number): string {
    const idle: Record<string, number> = {};
    if (now < this.restoredUntil) for (const [sessionId, ms] of this.restored) idle[sessionId] = ms;
    for (const [sessionId, ms] of this.live) idle[sessionId] = ms;
    return JSON.stringify({ at: now, idle });
  }
}

export async function captureProcessSnapshot(): Promise<Map<number, ProcessInfo>> {
  if (process.platform !== "darwin") return new Map();

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,pcpu=,rss=,etime="], {
    timeout: 5000,
    killSignal: "SIGKILL",
  });

  const collectedAt = Date.now();
  const result = new Map<number, ProcessInfo>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const cpu = parseFloat(parts[2]);
    const rss = parseInt(parts[3], 10);
    if (isNaN(pid) || isNaN(ppid) || isNaN(cpu) || isNaN(rss)) continue;
    // etime joined the column list after the other four, so an older daemon's
    // parse of a 4-column line still works and simply carries no start time.
    const elapsedSec = parts.length > 4 ? parseEtimeSeconds(parts[4]) : undefined;
    result.set(pid, {
      pid,
      ppid,
      cpu,
      rss: rss * 1024,
      ...(elapsedSec !== undefined ? { startedAt: collectedAt - elapsedSec * 1000 } : {}),
    });
  }
  return result;
}

export function getSubtreePids(
  snapshot: Map<number, ProcessInfo>,
  rootPid: number,
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const info of snapshot.values()) {
    let children = childrenOf.get(info.ppid);
    if (!children) {
      children = [];
      childrenOf.set(info.ppid, children);
    }
    children.push(info.pid);
  }

  const result: number[] = [];
  const stack = [rootPid];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    result.push(pid);
    const children = childrenOf.get(pid);
    if (children) {
      for (const child of children) stack.push(child);
    }
  }
  return result;
}

export function getSubtreeResources(
  snapshot: Map<number, ProcessInfo>,
  rootPid: number,
): { cpu: number; memory: number; pidCount: number } {
  const pids = getSubtreePids(snapshot, rootPid);
  let cpu = 0;
  let memory = 0;
  let pidCount = 0;
  for (const pid of pids) {
    const info = snapshot.get(pid);
    if (!info) continue;
    cpu += info.cpu;
    memory += info.rss;
    pidCount++;
  }
  return { cpu: Math.round(cpu * 100) / 100, memory, pidCount };
}

/**
 * Per-session resource usage, with each process tree credited EXACTLY ONCE.
 *
 * Two sessions can map to the same root pid. A Codex subagent thread shares its
 * parent TUI's process by design, and process discovery can also collide two
 * unrelated roots. Walking the subtree per session with no collision awareness
 * reported the same tree N times — observed live on 2026-08-02, 15 distinct Codex
 * session ids all resolved to pid 55521 and each reported the byte-identical
 * cpu=0.1% mem=265.0MB procs=10, summed 15x into the fleet total.
 *
 * `sharedPidSessions` names sessions already KNOWN not to own their root pid
 * (see the daemon's sessionProcessOwnership); they are never credited, so the
 * tree goes to the real owner. If no owner is tracked, the tree is simply not
 * counted — better uncounted than attributed to a session that doesn't own it.
 *
 * Among sessions with equal claim, the lexicographically smallest id wins. That
 * tie-break is deliberate: iteration order follows the caller's process cache,
 * which is evicted and refilled between ticks, so ordering by it would hand the
 * subtree to a different session on alternating ticks and make both sessions'
 * graphs flicker.
 */
export async function collectSessionResources(
  sessionPids: Map<string, number>,
  sharedPidSessions: ReadonlySet<string>,
): Promise<Map<string, SessionResources>> {
  if (process.platform !== "darwin") return new Map();

  const snapshot = await captureProcessSnapshot();
  if (snapshot.size === 0) return new Map();

  const ownerByRootPid = new Map<number, string>();
  for (const [sessionId, rootPid] of sessionPids) {
    if (sharedPidSessions.has(sessionId)) continue;
    const incumbent = ownerByRootPid.get(rootPid);
    if (incumbent === undefined || sessionId < incumbent) ownerByRootPid.set(rootPid, sessionId);
  }

  const result = new Map<string, SessionResources>();
  const now = Date.now();
  for (const [sessionId, rootPid] of sessionPids) {
    if (!snapshot.has(rootPid)) continue;
    // The root pid IS the agent process, so its start time is the session's
    // process generation — reported even by a borrower, whose cpu/memory are
    // zeroed but whose agent is just as real.
    const agentStartedAt = snapshot.get(rootPid)?.startedAt;
    const startedAtField = agentStartedAt !== undefined ? { agentStartedAt } : {};
    if (ownerByRootPid.get(rootPid) !== sessionId) {
      result.set(sessionId, {
        sessionId,
        cpu: 0,
        memory: 0,
        pidCount: 0,
        collectedAt: now,
        sharesRootPid: true,
        ...startedAtField,
      });
      continue;
    }
    const resources = getSubtreeResources(snapshot, rootPid);
    if (resources.pidCount === 0) continue;
    result.set(sessionId, {
      sessionId,
      ...resources,
      collectedAt: now,
      ...startedAtField,
    });
  }
  return result;
}

export function formatResourcesLog(resources: Map<string, SessionResources>): string {
  if (resources.size === 0) return "No active sessions with resource data";
  const lines: string[] = [];
  for (const [sessionId, r] of resources) {
    if (r.sharesRootPid) {
      lines.push(`${shortId(sessionId)}: shares another session's pid (not counted)`);
      continue;
    }
    const memMB = (r.memory / (1024 * 1024)).toFixed(1);
    lines.push(`${shortId(sessionId)}: cpu=${r.cpu}% mem=${memMB}MB procs=${r.pidCount}`);
  }
  return `Resource snapshot (${resources.size} sessions): ${lines.join(", ")}`;
}
