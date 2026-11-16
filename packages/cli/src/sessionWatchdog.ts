// Whether a LIVE agent process is hung or leaking memory, and so restarted.
//
// midWorkRevive.ts brings back a session whose process died mid-work. Two
// failures never die on their own: a process that wedges mid-turn (2026-10-25,
// a session froze for 3h17m on one shell command), and one that leaks until the
// machine swaps (the same session reached 55 GB). Until this shipped a local
// launchd script (~/.claude-watchdog/watchdog.py) watched for both, from
// outside. It counted only the transcript and its folder as activity, so on
// 2026-10-28 it killed b6e142dc "busy 47 min with no transcript writes for 30
// min" while that session waited on its own Workflow, whose agents wrote
// elsewhere, and the workflow died with it.
//
// Here the daemon decides, with what it knows about the session: a session
// waiting on its own background work (an open background command or Monitor,
// a running workflow) is never hung, whatever its transcript says. A restart
// stops the process and hands it to what already brings back a death: a
// mid-turn session to its turn claim (turnClaims.ts), a finished turn that
// owns work to the mid-work revive, both counted in the per-conversation
// revive budget; a session between turns is resumed without a message. No
// daemon import, so the test never loads daemon.ts.

import fs from "node:fs";
import path from "node:path";
import { watchdogRestartNote } from "@codecast/shared/contracts";
import { REVIVE_BUDGET, recentRevives } from "./midWorkRevive.js";
import { parseWorkflowJournal, snapshotIsCurrent } from "./workflowRunLive.js";

const MIN = 60_000;
const GIB = 1024 ** 3;

// The local script's defaults. A foreground Bash call is capped at 10 minutes,
// so 30 minutes mid-turn with no activity anywhere is not a slow command.
export const STUCK_MS = 30 * MIN;
// Logged once, as the local script's warning was.
export const MEM_WARN_BYTES = 20 * GIB;
// Claude Code's own "critical, restart" line: restarted when between turns.
export const MEM_RESTART_BYTES = 32 * GIB;
// Restarted even mid-turn.
export const MEM_FORCE_BYTES = 48 * GIB;

// Mid-turn: the agent said a turn is underway.
export const BUSY_STATUSES: ReadonlySet<string> = new Set(["working", "thinking", "compacting"]);
// Between turns, waiting on a person or a wake from outside the process.
// "waiting" is the daemon's word for a finished turn that still owns background
// work, so it is not here.
export const BETWEEN_TURN_STATUSES: ReadonlySet<string> = new Set(["idle", "stopped", "done", "dormant"]);

export type WatchdogFacts = {
  status: string | undefined;
  /** The transcript's last real message ended the turn: a busy status is a
   *  missed Stop hook, not a hang. */
  transcriptTurnEnded?: boolean;
  /** When the daemon first saw the current busy stretch (or the turn began). */
  busySinceMs: number | undefined;
  /** Newest activity of any kind (sessionLastActivityMs, the process's start). */
  lastActivityMs: number;
  /** The machine has been awake since then: time asleep is not time hung. */
  awakeSinceMs: number;
  /** What the session waits on inside its own process, or null: open
   *  background tasks, a running workflow. */
  waitingOn: string | null;
  /** Resident memory of the agent process itself. */
  rssBytes: number;
  /** Earlier revives and restarts of this conversation (the midWorkRevive ledger). */
  priorRestarts: readonly number[];
  now: number;
};

export type WatchdogVerdict =
  | { restart: false; reason: "healthy" | "waiting-on-own-work" | "memory-waits-for-turn-end" | "budget-spent"; detail?: string }
  | { restart: true; cause: "hung" | "memory"; resume: "revive" | "resume-only"; detail: string };

const mins = (ms: number) => Math.round(ms / MIN);
const gb = (bytes: number) => Math.round(bytes / GIB);

export function sessionWatchdogDecision(f: WatchdogFacts): WatchdogVerdict {
  const status = f.status ?? "";
  const busy = BUSY_STATUSES.has(status) && !f.transcriptTurnEnded;
  const quietMs = f.now - Math.max(f.lastActivityMs, f.awakeSinceMs);
  const busyMs = busy && f.busySinceMs !== undefined ? f.now - Math.max(f.busySinceMs, f.awakeSinceMs) : 0;
  const betweenTurns = BETWEEN_TURN_STATUSES.has(status) && !f.waitingOn;

  let want: { cause: "hung" | "memory"; detail: string } | null = null;
  let hold: Extract<WatchdogVerdict, { restart: false }> | null = null;
  if (busy && busyMs >= STUCK_MS && quietMs >= STUCK_MS) {
    if (f.waitingOn) hold = { restart: false, reason: "waiting-on-own-work", detail: f.waitingOn };
    else want = { cause: "hung", detail: `it hung: ${status} for ${mins(busyMs)} min with no activity for ${mins(quietMs)} min` };
  }
  if (!want && f.rssBytes >= MEM_RESTART_BYTES) {
    if (betweenTurns || f.rssBytes >= MEM_FORCE_BYTES) {
      want = { cause: "memory", detail: `it leaked memory (${gb(f.rssBytes)} GB resident)` };
    } else {
      hold ??= { restart: false, reason: "memory-waits-for-turn-end", detail: `${gb(f.rssBytes)} GB, ${status || "unknown status"}${f.waitingOn ? `, waiting on ${f.waitingOn}` : ""}` };
    }
  }
  if (!want) return hold ?? { restart: false, reason: "healthy" };
  if (recentRevives(f.priorRestarts, f.now) >= REVIVE_BUDGET) return { restart: false, reason: "budget-spent", detail: want.detail };
  // A session between turns with nothing in flight comes back without a turn
  // spent; anything else lost work and is told so by the revive.
  return { restart: true, cause: want.cause, resume: betweenTurns ? "resume-only" : "revive", detail: want.detail };
}

/** The revive queued after a restart: the mid-work revive, plus why. */
export function watchdogReviveMessage(detail: string): string {
  return watchdogRestartNote(detail);
}

// Everything a session writes lives under its transcript's folder: subagent
// transcripts, workflow journals and agent transcripts, tool results. The walk
// is bounded so a session with a huge folder costs a fixed amount.
const ACTIVITY_WALK_MAX_ENTRIES = 5_000;

/** Newest write to the session's transcript or anything under its folder. */
export async function sessionLastActivityMs(transcriptPath: string): Promise<number> {
  let latest = await fs.promises.stat(transcriptPath).then((s) => s.mtimeMs, () => 0);
  const root = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"));
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < ACTIVITY_WALK_MAX_ENTRIES) {
    const dir = queue.pop()!;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (++seen > ACTIVITY_WALK_MAX_ENTRIES) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { queue.push(p); continue; }
      latest = Math.max(latest, await fs.promises.stat(p).then((s) => s.mtimeMs, () => 0));
    }
  }
  return latest;
}

/** Workflow runs of this session with an agent still running, by the journal
 *  (workflowRunLive.ts). A run whose journal is older than the current process
 *  belonged to a process that is gone and cannot be running. */
export async function liveWorkflowRuns(transcriptPath: string, processStartedAt?: number): Promise<string[]> {
  const hostDir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"));
  const runsDir = path.join(hostDir, "subagents", "workflows");
  const live: string[] = [];
  for (const runId of await fs.promises.readdir(runsDir).catch(() => [] as string[])) {
    const runDir = path.join(runsDir, runId);
    const journalPath = path.join(runDir, "journal.jsonl");
    const journalMtime = await fs.promises.stat(journalPath).then((s) => s.mtimeMs, () => undefined);
    if (journalMtime === undefined) continue;
    if (processStartedAt !== undefined && journalMtime < processStartedAt) continue;
    const snapshotMtime = await fs.promises.stat(path.join(hostDir, "workflows", `${runId}.json`)).then((s) => s.mtimeMs, () => undefined);
    if (snapshotIsCurrent(snapshotMtime, journalMtime)) continue;
    const agents = parseWorkflowJournal(await fs.promises.readFile(journalPath, "utf8").catch(() => ""));
    for (const a of agents) {
      if (a.state !== "running") continue;
      // After a resume, an attempt the stop cut off stays open until the
      // script reaches its key again; it is not running.
      if (snapshotMtime !== undefined) {
        const mtime = await fs.promises.stat(path.join(runDir, `agent-${a.agent_id}.jsonl`)).then((s) => s.mtimeMs, () => 0);
        if (snapshotIsCurrent(snapshotMtime, mtime)) continue;
      }
      live.push(runId);
      break;
    }
  }
  return live;
}

/** The one-line "waiting on" a hold is logged with, or null for nothing. */
export function describeOwnWork(openTasks: number, workflowRuns: readonly string[], status: string | undefined): string | null {
  const parts: string[] = [];
  if (workflowRuns.length) parts.push(`workflow ${workflowRuns.join(", ")}`);
  if (openTasks) parts.push(`${openTasks} background task(s)`);
  if (!parts.length && status === "waiting") parts.push("background work (status waiting)");
  return parts.length ? parts.join(" and ") : null;
}
