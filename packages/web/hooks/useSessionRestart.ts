import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";

// How long the resume ladder gets to bring a session live before the merged
// "Restart session" escalates to a forced rebuild from server history. Long
// enough for a normal resume + reconnect, short enough that a wedged restart
// recovers on its own.
const RESTART_ESCALATE_AFTER_MS = 45_000;
// Backstop for the whole two-stage recovery (resume window + rebuild window +
// slack). Past this we stop tracking so nothing spins forever when an offline
// daemon or a dead machine means no one is ever going to answer.
const RESTART_GIVE_UP_AFTER_MS = RESTART_ESCALATE_AFTER_MS * 2 + 30_000;
// A restart request no daemon has stamped after this long usually means the
// owning device is offline — the one failure the command rows can't report.
const RESTART_UNCLAIMED_WARN_MS = 20_000;
// How long the "restored" confirmation stays up before clearing to idle.
const RESTART_RESTORED_LINGER_MS = 5_000;

// Context for restoring a server-deleted (ghost) conversation: for a deleted
// row the server knows nothing, so restartSession/repairSession take the
// session binding from our cached copy. Shared by every restart call site on
// web AND mobile.
export function ghostRestartContextFor(conversationId: string) {
  const s = useInboxStore.getState();
  const row: any = s.conversations[conversationId] ?? s.sessions[conversationId];
  if (!row) return {};
  return {
    session_id: row.session_id,
    project_path: row.project_path ?? row.git_root,
    agent_type: row.agent_type,
    title: row.title,
  };
}

export type RestartProgressRow = {
  command: string;
  created_at: number;
  executed_at: number | null;
  result: string | null;
  error: string | null;
};

export type RestartStage = { label: string; tone: "active" | "warn" | "error" };

// Live label for a kill+restart in flight, derived from the daemon command
// rows (conversations.getRestartProgress — the daemon stamps executed_at +
// result/error on each). Shared by the composer footer ladder, the on-message
// retry bar, and the header restart strip so all report the same real progress.
export function deriveRestartStage(
  restartProgress: RestartProgressRow[] | null | undefined,
  waitingLong: boolean,
): RestartStage | null {
  if (!restartProgress?.length) return null;
  const last = [...restartProgress].reverse();
  const resume = last.find((c) => c.command === "resume_session");
  const kill = last.find((c) => c.command === "kill_session");
  if (resume?.executed_at) {
    if (resume.error) return { label: `Restart failed: ${resume.error}`, tone: "error" };
    try {
      const r = resume.result ? JSON.parse(resume.result) : null;
      if (r?.reconstituted) return { label: "Rebuilt session from history — reconnecting…", tone: "active" };
      if (r?.started_fresh) return { label: "Couldn't resume the old session — started a fresh one", tone: "active" };
      if (r?.resumed) return { label: "Session resumed — reconnecting…", tone: "active" };
      if (r?.skipped) return { label: "Session is already starting…", tone: "active" };
    } catch { /* plain-string results fall through to the generic label */ }
    return { label: "Restarting session…", tone: "active" };
  }
  if (kill?.executed_at) return { label: "Old session stopped — starting replacement…", tone: "active" };
  if (waitingLong) return { label: "Waiting for the daemon to pick this up — is that device online?", tone: "warn" };
  return { label: "Restart requested — waiting for daemon…", tone: "active" };
}

// Lifecycle of the one-click recovery, for callers that render live status:
// restarting (in flight) → restored (came live; auto-clears) | failed (gave up
// or the request itself errored; sticks until retried or the session revives).
export type RestartPhase = "idle" | "restarting" | "restored" | "failed";

/**
 * One reliable "Restart session" action that drives BOTH recovery codepaths so a
 * session is never left dead:
 *
 *  1. `restartSession` — the context-preserving ladder. On the daemon this resumes
 *     the local transcript (full history, warm prompt cache); only if that fails
 *     does it repair / reconstitute / start a blank session.
 *  2. If the session doesn't come live — the daemon reports a hard resume error,
 *     or `isLive` stays false past RESTART_ESCALATE_AFTER_MS — it escalates ONCE to
 *     `repairSession`, the forced rebuild from server history. That catches the
 *     cases resume can't: a stale/corrupt local transcript, or a resume the daemon
 *     reported as succeeded but that actually wedged.
 *
 * `isLive` is the caller's authoritative "the session is alive right now" signal
 * (daemon-connected / agent active). The escalation only ever chains onto a
 * restart that was already authorized — it is never a fresh, unprompted kill.
 *
 * Besides firing the recovery, the hook narrates it: `phase` flips to
 * "restarting" synchronously on click (feedback before any server ack), `stage`
 * tracks the daemon's kill→resume ladder live, and `failure` carries the reason
 * when the whole recovery gives up.
 */
export function useSessionRestart(opts: {
  conversationId: string;
  isLive: boolean;
  ghostContext: () => Record<string, unknown>;
  onRestored?: (res: unknown) => boolean;
  /** Platform toast — sonner on web, RN toast on mobile. */
  notify: (kind: "success" | "error" | "info", message: string) => void;
}): {
  restart: () => void;
  isRestarting: boolean;
  phase: RestartPhase;
  stage: RestartStage | null;
  failure: string | null;
  startedAt: number | null;
} {
  const { conversationId, isLive, ghostContext, onRestored, notify } = opts;
  const convCommand = useInboxStore((s) => s.convCommand);
  const [phase, setPhase] = useState<RestartPhase>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const isRestarting = phase === "restarting";
  const escalatedRef = useRef(false);

  // Live kill→resume ladder from the daemon (getRestartProgress stamps each
  // command with executed_at + result/error). Skip-gated so it costs nothing
  // outside an in-flight restart; drives both the caller-visible stage and the
  // instant escalation on a hard resume failure.
  const restartProgressRaw = useQuery(
    api.conversations.getRestartProgress,
    isRestarting && isConvexId(conversationId) ? { conversation_id: conversationId } : "skip",
  ) as RestartProgressRow[] | null | undefined;
  // Scope to THIS click: the query returns the conversation's last few
  // kill/resume commands, which can include rows from an earlier restart — a
  // stale errored resume row would otherwise read as an instant hard failure.
  // 10s tolerance covers client/server clock skew.
  const restartProgress = useMemo(
    () => (startedAt ? restartProgressRaw?.filter((c) => c.created_at >= startedAt - 10_000) : restartProgressRaw),
    [restartProgressRaw, startedAt],
  );

  // Flips on when the request has sat unclaimed long enough that the owning
  // daemon is probably offline.
  const [waitingLong, setWaitingLong] = useState(false);
  useWatchEffect(() => {
    if (!isRestarting) { setWaitingLong(false); return; }
    if (restartProgress?.some((c) => c.executed_at)) { setWaitingLong(false); return; }
    const t = setTimeout(() => setWaitingLong(true), RESTART_UNCLAIMED_WARN_MS);
    return () => clearTimeout(t);
  }, [isRestarting, restartProgress]);

  const stage = useMemo(
    () => (isRestarting ? deriveRestartStage(restartProgress, waitingLong) : null),
    [isRestarting, restartProgress, waitingLong],
  );

  const restart = useCallback(() => {
    if (!isConvexId(conversationId)) return;
    // Already mid-recovery: the ladder owns it — a second kill underneath would
    // only race the resume it's waiting on.
    if (phase === "restarting") return;
    escalatedRef.current = false;
    setFailure(null);
    setStartedAt(Date.now());
    setPhase("restarting");
    convCommand(conversationId, "restartSession", ghostContext())
      .then((res: unknown) => { if (!onRestored?.(res)) notify("success", "Restarting session…"); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/conversation_deleted|Conversation not found/i.test(msg)) {
          useInboxStore.getState().markServerDeleted(conversationId);
          setPhase("idle");
          notify("error", "This conversation no longer exists on the server — use Restore to bring its session back");
        } else {
          setFailure(`Failed to restart session: ${msg}`);
          setPhase("failed");
          notify("error", `Failed to restart session: ${msg}`);
        }
      });
  }, [conversationId, convCommand, ghostContext, onRestored, notify, phase]);

  // Session came live → the recovery is done. Confirm it, then clear. A late
  // revival also clears a stuck "failed" — the error is no longer true.
  useWatchEffect(() => {
    if (isRestarting && isLive) {
      setPhase("restored");
      notify("success", "Session is back live");
    } else if (phase === "failed" && isLive) {
      setPhase("idle");
    }
  }, [isRestarting, phase, isLive]);
  useWatchEffect(() => {
    if (phase !== "restored") return;
    const t = setTimeout(() => setPhase((p) => (p === "restored" ? "idle" : p)), RESTART_RESTORED_LINGER_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Fallback on both codepaths: escalate ONCE to the forced rebuild if resume
  // hard-fails, or if the session simply hasn't come live within the window.
  useWatchEffect(() => {
    if (!isRestarting || escalatedRef.current || isLive) return;
    if (!isConvexId(conversationId)) return;
    const escalate = () => {
      if (escalatedRef.current) return;
      escalatedRef.current = true;
      notify("info", "Resume didn't take — rebuilding the session from history…");
      convCommand(conversationId, "repairSession", ghostContext())
        .then((res: unknown) => onRestored?.(res))
        .catch(() => { /* the give-up backstop below reports the failure */ });
    };
    // Daemon says resume/repair/reconstitute all fell through — rebuild now.
    const resumeRow = [...(restartProgress ?? [])]
      .reverse()
      .find((c) => c.command === "resume_session" && c.executed_at);
    if (resumeRow?.error) { escalate(); return; }
    // Otherwise give the resume ladder its full window, then escalate if still no life.
    const remaining = RESTART_ESCALATE_AFTER_MS - (Date.now() - (startedAt ?? Date.now()));
    const t = setTimeout(escalate, Math.max(0, remaining));
    return () => clearTimeout(t);
  }, [isRestarting, isLive, restartProgress, conversationId, convCommand, ghostContext, onRestored, notify, startedAt]);

  // Give-up backstop: after both stages have had their window, stop tracking —
  // and say so — rather than spin forever if nothing is ever going to revive it.
  useWatchEffect(() => {
    if (!isRestarting) return;
    const t = setTimeout(() => {
      setFailure("Session didn't come back — the device may be offline. Check the daemon, or try again.");
      setPhase("failed");
      notify("error", "Restart didn't bring the session back — the device may be offline");
    }, RESTART_GIVE_UP_AFTER_MS);
    return () => clearTimeout(t);
  }, [isRestarting]);

  return { restart, isRestarting, phase, stage, failure, startedAt };
}
