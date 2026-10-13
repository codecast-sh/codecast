// Whether a session whose agent process died mid-work is brought back.
//
// The watchdog finds sessions whose status file went stale and whose process
// is gone. For a session that had finished its turn that is the end: marking
// it completed is right. For one that was still working, or waiting on its own
// background work (a workflow, a background command, a monitor), the death was
// an accident: a tmux server restart, a daemon restart, a crash. The work
// inside the process died with it, and before this nothing brought it back, so
// the session sat "stopped" until a person noticed and typed "continue"
// (jx7e4fy, 2026-10-03 and twice on 2026-10-05, eight hours each time).
//
// So the watchdog asks this module first. A revive is an ordinary message
// queued to the conversation: delivery resumes the dead session and the agent
// reads it as its next turn, alongside Claude Code's own notes about which
// background tasks the exit stopped. No filesystem besides the ledger, no
// tmux, no daemon import, so the test never loads daemon.ts.

import fs from "node:fs";
import path from "node:path";
import { MID_WORK_REVIVE_MESSAGE, reviveClientId } from "@codecast/shared/contracts";
import { workflowRunLastActivity } from "./workflowRunLive.js";

// The statuses that mean the turn was not over. "waiting" is the daemon's word
// for a finished turn that still owns background work. A permission prompt
// waits on a person, and "dormant" waits on a trigger that will wake it anyway.
export const REVIVABLE_STATUSES: ReadonlySet<string> = new Set(["working", "thinking", "compacting", "waiting"]);

// A session silent this long died on work nobody would expect to resume now;
// the first pass after this ships must not wake sessions that died days ago.
export const REVIVE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// A session that dies again and again after each revive has a problem a
// continue will not fix. After this many revives inside the window it is left
// stopped for a person to look at.
export const REVIVE_BUDGET = 3;
export const REVIVE_BUDGET_WINDOW_MS = 6 * 60 * 60 * 1000;

// Each revive resumes a process whose first request carries its whole context.
// A mass death (a tmux server restart takes every pane) would otherwise resume
// dozens at once and spike load and the provider's per-minute cap. The rest
// wait for the next watchdog pass, five minutes later.
export const REVIVE_MAX_PER_PASS = 3;

// The web recognizes it by content (isMidWorkReviveNotice) to render it as
// a restart rule and keep it out of the sticky prompt.
export const REVIVE_MESSAGE = MID_WORK_REVIVE_MESSAGE;

// Shares the recovery prefix family (isRecoveryContinueClientId), so the web
// shows it as the system's message rather than the person's. Minute-bucketed
// like blockedContinueClientId: a pass that runs twice cannot double-queue.
export { reviveClientId };

export type ReviveLifecycle = {
  hideStateKnown?: boolean;
  inboxKilledAt?: number | null;
  inboxDismissedAt?: number | null;
} | null | undefined;

// The status cleanup's retention. A status file that says the turn was not
// over is the watchdog's only evidence that a session died mid-work, and the
// watchdog removes it itself once the process is gone. A session waiting on a
// workflow writes no status for hours, so a one-hour cutoff deleted the file
// of a live session: fdf643a3 ended its turn at 02:00Z on 2026-10-06 with a
// workflow running, lost its file to the cleanup at 04:36Z, died with twenty
// other sessions at 04:41Z, and was the one the watchdog never saw. The long
// bound only clears files the watchdog never settles (a session that moved to
// another machine).
export const UNFINISHED_STATUS_FILE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export function statusFileExpired(status: string | undefined, mtimeMs: number, now: number, finishedTtlMs: number): boolean {
  const ttl = REVIVABLE_STATUSES.has(status ?? "") ? UNFINISHED_STATUS_FILE_TTL_MS : finishedTtlMs;
  return now - mtimeMs > ttl;
}

// When a dead session last did anything: its transcript, or any subagent or
// workflow agent it hosted. A session waiting on a workflow wrote its status
// when its turn ended, often hours before the workflow and the process died,
// so the status file's age says nothing about how long ago it was alive.
export async function lastSignOfLifeMs(transcriptPath: string): Promise<number> {
  let latest = await fs.promises.stat(transcriptPath).then((s) => s.mtimeMs, () => 0);
  const subagents = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"), "subagents");
  const runs = await fs.promises.readdir(path.join(subagents, "workflows")).catch(() => [] as string[]);
  for (const dir of [subagents, ...runs.map((run) => path.join(subagents, "workflows", run))]) {
    latest = Math.max(latest, await workflowRunLastActivity(dir).catch(() => 0));
  }
  return latest;
}

export type ReviveFacts = {
  status: string | undefined;
  /** Time since the session last showed life: its status file, its
   *  transcript, or an agent it hosted (lastSignOfLifeMs). */
  ageMs: number;
  lifecycle: ReviveLifecycle;
  /** The person stopped the turn (Escape, Ctrl+C). */
  interruptedByUser: boolean;
  /** The turn ended on a usage limit; the account recovery chain owns it. */
  limitParked: boolean;
  /** Earlier revives of this session, epoch ms. */
  priorRevives: readonly number[];
  now: number;
};

export type ReviveDecision = { revive: true } | { revive: false; reason: string };

export function midWorkReviveDecision(f: ReviveFacts): ReviveDecision {
  if (!REVIVABLE_STATUSES.has(f.status ?? "")) return { revive: false, reason: "turn-finished" };
  if (f.ageMs > REVIVE_MAX_AGE_MS) return { revive: false, reason: "too-old" };
  // Unknown hide state fails toward the old behavior (mark it completed): a
  // revive the person did not want costs a turn, and here nothing says they
  // still hold the session.
  if (!f.lifecycle || !f.lifecycle.hideStateKnown) return { revive: false, reason: "lifecycle-unknown" };
  // A stash keeps the agent running by design, so only a kill or a dismiss
  // says the person is done with it.
  if (f.lifecycle.inboxKilledAt || f.lifecycle.inboxDismissedAt) return { revive: false, reason: "retired" };
  if (f.interruptedByUser) return { revive: false, reason: "interrupted" };
  if (f.limitParked) return { revive: false, reason: "limit-parked" };
  const recent = f.priorRevives.filter((t) => f.now - t < REVIVE_BUDGET_WINDOW_MS).length;
  if (recent >= REVIVE_BUDGET) return { revive: false, reason: "budget-spent" };
  return { revive: true };
}

// The ledger: when each session was last revived. The daemon restarts often
// (every source change), so the budget has to outlive it.
type Ledger = Record<string, number[]>;

function readLedger(file: string): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Ledger : {};
  } catch {
    return {};
  }
}

export function priorRevives(file: string, sessionId: string): number[] {
  const list = readLedger(file)[sessionId];
  return Array.isArray(list) ? list.filter((t) => typeof t === "number") : [];
}

export function recordRevive(file: string, sessionId: string, at: number): void {
  const ledger = readLedger(file);
  for (const [id, list] of Object.entries(ledger)) {
    const kept = list.filter((t) => at - t < REVIVE_BUDGET_WINDOW_MS);
    if (kept.length) ledger[id] = kept; else delete ledger[id];
  }
  ledger[sessionId] = [...(ledger[sessionId] ?? []), at];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger));
  fs.renameSync(tmp, file);
}
