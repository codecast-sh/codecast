import { useCallback, useRef } from "react";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { useWatchEffect } from "./useWatchEffect";
import { useCoarseNow } from "./useCoarseNow";
import { useConversationCommands } from "./useSessionCommands";
import {
  COMMAND_UNCLAIMED_WARN_MS,
  DISPATCH_REFUSED,
  RESTART_ESCALATE_AFTER_MS,
  latestRestartRow,
  requestSessionRestart,
  sessionCommandStartedAt,
  sessionCommandTimedOut,
  type SessionCommandRow,
} from "../lib/sessionCommands";

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

export type RestartProgressRow = Pick<SessionCommandRow, "command" | "requested_at" | "executed_at" | "result" | "error">;

export type RestartStage = { label: string; tone: "active" | "warn" | "error" };

// Live label for a kill+restart in flight, derived from the daemon command
// rows (sessionCommands, fed by forConversation — the daemon stamps
// executed_at + result/error on each). Shared by the composer footer ladder, the on-message
// retry bar, and the header restart strip so all report the same real progress.
export function deriveRestartStage(
  restartProgress: RestartProgressRow[] | null | undefined,
  waitingLong: boolean,
  sessionReady = false,
): RestartStage | null {
  if (!restartProgress?.length) return null;
  const last = [...restartProgress].reverse();
  const resume = last.find((c) => c.command === "resume_session");
  const kill = last.find((c) => c.command === "kill_session");
  if (resume?.executed_at) {
    if (resume.error) return { label: `Restart failed: ${resume.error}`, tone: "error" };
    try {
      const r = resume.result ? JSON.parse(resume.result) : null;
      if (r?.cloud_agent) return { label: "Runs in the cloud: nothing to restart here, and a held message goes out on its own", tone: "active" };
      if (sessionReady && (r?.resumed || r?.reconstituted || r?.started_fresh)) {
        return { label: "Session is ready — waiting for message delivery…", tone: "active" };
      }
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

// Lifecycle of the one-click recovery, for callers that render live status:
// restarting (in flight) → restored (came live; clears after a moment) |
// failed (refused, the rebuild failed, or nothing answered in time).
export type RestartPhase = "idle" | "restarting" | "restored" | "failed";

/** The resume that decides a restart: the row the click bound, or, when the
 *  server folded the click into a resume already queued, the newest resume
 *  in the pipeline since the click. */
export function restartResumeRow(gesture: SessionCommandRow, progress: RestartProgressRow[]): RestartProgressRow | undefined {
  if (gesture.executed_at) return gesture;
  return [...progress].reverse().find((c) => c.command === "resume_session" && c.executed_at);
}

/** Proof the restart worked: the session is live AND the daemon stamped the
 *  resume clean. At click time isLive is usually the pre-kill snapshot, so it
 *  alone never confirms. */
export function restartConfirmedLive(isLive: boolean, resume: RestartProgressRow | undefined): boolean {
  return isLive && !!resume?.executed_at && !resume.error;
}

/** The phase a restart's row reads as now. */
export function restartPhaseOf(gesture: SessionCommandRow | undefined, now: number): { phase: RestartPhase; failure: string | null } {
  if (!gesture) return { phase: "idle", failure: null };
  if (gesture.confirmed_at) return { phase: now - gesture.confirmed_at < RESTART_RESTORED_LINGER_MS ? "restored" : "idle", failure: null };
  if (gesture.result === DISPATCH_REFUSED) return { phase: "failed", failure: `Failed to restart session: ${gesture.error ?? "refused"}` };
  // A restart's own resume error is not the end: the repair escalation follows.
  if (gesture.kind === "repair" && gesture.executed_at && gesture.error) return { phase: "failed", failure: `Restart failed: ${gesture.error}` };
  if (!sessionCommandTimedOut(gesture, now)) return { phase: "restarting", failure: null };
  return { phase: "failed", failure: "Session didn't come back — the device may be offline. Check the daemon, or try again." };
}

/**
 * One reliable "Restart session" action that drives BOTH recovery codepaths so a
 * session is never left dead:
 *
 *  1. restart — the context-preserving ladder. On the daemon this resumes the
 *     local transcript (full history, warm prompt cache); only if that fails
 *     does it repair / reconstitute / start a blank session.
 *  2. If the session doesn't come live — the daemon reports a hard resume error,
 *     or `isLive` stays false past RESTART_ESCALATE_AFTER_MS — it escalates ONCE to
 *     repair, the forced rebuild from server history.
 *
 * Both go through the store's restartSession action, which paints a
 * sessionCommands row on the click; the phase, the daemon's live stage and the
 * failure are all READ from that row and the conversation's pipeline rows, so
 * every surface (this header, the inbox row) agrees and a reload keeps it.
 */
export function useSessionRestart(opts: {
  conversationId: string;
  isLive: boolean;
  ghostContext: () => Record<string, unknown>;
  onRestored?: (res: unknown) => boolean;
  /** Platform toast — sonner on web, RN toast on mobile. */
  notify: (kind: "success" | "error" | "info", message: string) => void;
  /** A refused restart. Web has the dispatch-failure toast already; mobile
   *  passes this to say it. */
  onRefused?: (message: string) => void;
}): {
  restart: () => void;
  isRestarting: boolean;
  phase: RestartPhase;
  stage: RestartStage | null;
  failure: string | null;
  startedAt: number | null;
} {
  const { conversationId, isLive, ghostContext, onRestored, notify, onRefused } = opts;
  const gesture = useInboxStore((s) => latestRestartRow(s.sessionCommands, conversationId));
  const live = !!gesture && (!gesture.confirmed_at || Date.now() - gesture.confirmed_at < RESTART_RESTORED_LINGER_MS);
  const now = useCoarseNow(live ? 1_000 : 60_000);
  const { phase, failure } = restartPhaseOf(gesture, now);
  const startedAt = gesture ? sessionCommandStartedAt(gesture) : null;
  // Fed while the outcome is open: in flight, or given up but still able to
  // confirm a late revival.
  const rows = useConversationCommands(conversationId, !!gesture && !gesture.confirmed_at && gesture.result !== DISPATCH_REFUSED);
  const progress: RestartProgressRow[] = startedAt == null ? [] : rows.filter((c) =>
    c.requested_at >= startedAt - 10_000 && (c.command === "kill_session" || c.command === "resume_session"));
  const resume = gesture ? restartResumeRow(gesture, progress) : undefined;
  const waitingLong = startedAt != null && !progress.some((c) => c.executed_at) && now - startedAt > COMMAND_UNCLAIMED_WARN_MS;
  const stage = phase === "restarting" ? deriveRestartStage(progress, waitingLong) : null;

  const fire = useCallback((repair: boolean) => {
    requestSessionRestart(conversationId, ghostContext(), repair)
      .then((res: unknown) => {
        if (!onRestored?.(res) && !repair) notify("success", "Restarting session…");
      })
      .catch((err: unknown) => {
        // A parked request is durable: the outbox re-drives it and its row
        // stays in flight until the echo or the deadline settles it.
        if (isParkedDispatchError(err)) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (/conversation_deleted|Conversation not found/i.test(msg)) {
          const store = useInboxStore.getState();
          store.markServerDeleted(conversationId);
          const row = latestRestartRow(store.sessionCommands, conversationId);
          if (row) store.dismissSessionCommand(row._id);
          notify("error", "This conversation no longer exists on the server — use Restore to bring its session back");
          return;
        }
        onRefused?.(`Failed to restart session: ${msg}`);
      });
  }, [conversationId, ghostContext, onRestored, notify, onRefused]);

  const restart = useCallback(() => {
    if (!isConvexId(conversationId)) return;
    // Already mid-recovery: the ladder owns it — a second kill underneath would
    // only race the resume it's waiting on.
    const cur = latestRestartRow(useInboxStore.getState().sessionCommands, conversationId);
    if (restartPhaseOf(cur, Date.now()).phase === "restarting") return;
    fire(false);
  }, [conversationId, fire]);

  // The session came back: stamp the row confirmed (every surface reads that)
  // and say so, once. A late revival after a give-up confirms too.
  useWatchEffect(() => {
    if (!gesture || gesture.confirmed_at || gesture.result === DISPATCH_REFUSED) return;
    if (!restartConfirmedLive(isLive, resume)) return;
    useInboxStore.getState().confirmSessionCommand(gesture._id);
    notify("success", "Session is back live");
  }, [gesture, isLive, resume]);

  // Escalate ONCE to the forced rebuild: at once on a hard resume failure,
  // otherwise when the session still isn't live after the resume window. The
  // repair row replaces the restart's, which is what makes it once.
  useWatchEffect(() => {
    if (!gesture || gesture.kind !== "restart" || gesture.confirmed_at || gesture.result === DISPATCH_REFUSED) return;
    if (isLive || !isConvexId(conversationId)) return;
    const escalate = () => {
      notify("info", "Resume didn't take — rebuilding the session from history…");
      fire(true);
    };
    if (resume?.error) { escalate(); return; }
    const t = setTimeout(escalate, Math.max(0, RESTART_ESCALATE_AFTER_MS - (Date.now() - sessionCommandStartedAt(gesture))));
    return () => clearTimeout(t);
  }, [gesture, isLive, resume?.error, conversationId, fire]);

  // Say a give-up once, and only to someone who watched it in flight here:
  // not on navigating to a conversation whose restart gave up earlier.
  const watching = useRef<{ conv: string; id: string } | null>(null);
  if (watching.current && watching.current.conv !== conversationId) watching.current = null;
  if (phase === "restarting" && gesture) watching.current = { conv: conversationId, id: gesture._id };
  useWatchEffect(() => {
    if (!gesture || phase !== "failed" || watching.current?.id !== gesture._id) return;
    watching.current = null;
    if (gesture.result !== DISPATCH_REFUSED && sessionCommandTimedOut(gesture, now)) {
      notify("error", "Restart didn't bring the session back — the device may be offline");
    }
  }, [gesture, phase, now]);

  return { restart, isRestarting: phase === "restarting", phase, stage, failure, startedAt };
}
