import { useCallback, useRef, useState } from "react";
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

type RestartProgressRow = {
  command: string;
  created_at: number;
  executed_at: number | null;
  result: string | null;
  error: string | null;
};

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
 */
export function useSessionRestart(opts: {
  conversationId: string;
  isLive: boolean;
  ghostContext: () => Record<string, unknown>;
  onRestored?: (res: unknown) => boolean;
  /** Platform toast — sonner on web, RN toast on mobile. */
  notify: (kind: "success" | "error" | "info", message: string) => void;
}): { restart: () => void; isRestarting: boolean } {
  const { conversationId, isLive, ghostContext, onRestored, notify } = opts;
  const convCommand = useInboxStore((s) => s.convCommand);
  const [isRestarting, setIsRestarting] = useState(false);
  const escalatedRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);

  // Live kill→resume ladder from the daemon (getRestartProgress stamps each
  // command with executed_at + result/error). Skip-gated so it costs nothing
  // outside an in-flight restart; used here only to escalate the instant the
  // daemon reports a hard resume failure instead of waiting out the timer.
  const restartProgress = useQuery(
    api.conversations.getRestartProgress,
    isRestarting && isConvexId(conversationId) ? { conversation_id: conversationId } : "skip",
  ) as RestartProgressRow[] | null | undefined;

  const restart = useCallback(() => {
    if (!isConvexId(conversationId)) return;
    escalatedRef.current = false;
    startedAtRef.current = Date.now();
    setIsRestarting(true);
    convCommand(conversationId, "restartSession", ghostContext())
      .then((res: unknown) => { if (!onRestored?.(res)) notify("success", "Restarting session…"); })
      .catch((err: unknown) => {
        setIsRestarting(false);
        const msg = err instanceof Error ? err.message : String(err);
        if (/conversation_deleted|Conversation not found/i.test(msg)) {
          useInboxStore.getState().markServerDeleted(conversationId);
          notify("error", "This conversation no longer exists on the server — use Restore to bring its session back");
        } else {
          notify("error", `Failed to restart session: ${msg}`);
        }
      });
  }, [conversationId, convCommand, ghostContext, onRestored, notify]);

  // Session came live → the recovery is done.
  useWatchEffect(() => {
    if (isRestarting && isLive) setIsRestarting(false);
  }, [isRestarting, isLive]);

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
        .catch(() => { /* the give-up backstop below stops the spinner */ });
    };
    // Daemon says resume/repair/reconstitute all fell through — rebuild now.
    const resumeRow = [...(restartProgress ?? [])]
      .reverse()
      .find((c) => c.command === "resume_session" && c.executed_at);
    if (resumeRow?.error) { escalate(); return; }
    // Otherwise give the resume ladder its full window, then escalate if still no life.
    const remaining = RESTART_ESCALATE_AFTER_MS - (Date.now() - (startedAtRef.current ?? Date.now()));
    const t = setTimeout(escalate, Math.max(0, remaining));
    return () => clearTimeout(t);
  }, [isRestarting, isLive, restartProgress, conversationId, convCommand, ghostContext, onRestored, notify]);

  // Give-up backstop: after both stages have had their window, stop tracking so
  // the caller never spins forever if nothing is ever going to revive it.
  useWatchEffect(() => {
    if (!isRestarting) return;
    const t = setTimeout(() => setIsRestarting(false), RESTART_GIVE_UP_AFTER_MS);
    return () => clearTimeout(t);
  }, [isRestarting]);

  return { restart, isRestarting };
}
