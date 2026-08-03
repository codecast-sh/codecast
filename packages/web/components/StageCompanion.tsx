"use client";
import { memo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Maximize2, X } from "lucide-react";
import { useTrackedStore, useInboxStore, getSessionRenderKey } from "../store/inboxStore";
import { InboxConversation } from "./GlobalSessionPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { animatedHideSession } from "../store/undoActions";

// The second (and last) pane the stage can hold: a live conversation running
// beside the page you're working on — "watch a session while reading a task".
//
// The cap is structural, not a policy: exactly ONE companion id exists in the
// store, so opening another swaps this one out. The session RAIL is never
// involved (it stays the glanceable list), which is what keeps this from
// becoming the old column pileup.
//
//   ⤢  promote the conversation to the whole stage (leaves the page)
//   ✕  close it — the page reclaims the full stage
export const StageCompanion = memo(function StageCompanion() {
  const s = useTrackedStore([
    (st) => st.companionSessionId,
    // Only this row is read — subscribing to the whole map would re-render the
    // companion on every other session's heartbeat.
    (st) => st.sessions[st.companionSessionId ?? ""],
  ]);
  const router = useRouter();
  const id = s.companionSessionId;
  const session = id ? (s.sessions[id] ?? null) : null;

  const handleClose = useCallback(() => {
    useInboxStore.getState().closeCompanion();
  }, []);

  const handleExpand = useCallback(() => {
    if (!id) return;
    const store = useInboxStore.getState();
    store.closeCompanion();
    store.navigateToSession(id);
    router.push("/inbox");
  }, [id, router]);

  const handleSendAndDismiss = useCallback(() => {
    if (id) animatedHideSession(id, "stash");
  }, [id]);

  // A companion whose row vanished (killed, pruned) closes itself rather than
  // holding an empty pane.
  if (!id || !session) return null;

  return (
    <div className="h-full flex flex-col border-l border-sol-border/30 bg-sol-bg">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-sol-border/20 bg-sol-bg-alt/50 flex-shrink-0">
        <span className="text-[11px] text-sol-text-muted truncate min-w-0 flex-1" title={session.title || "Session"}>
          {session.title || "Session"}
        </span>
        <button
          onClick={handleExpand}
          className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan transition-colors"
          title="Open full — the conversation takes the whole stage"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleClose}
          className="p-1 rounded-md text-sol-text-dim hover:text-sol-red transition-colors"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <ErrorBoundary name="StageCompanion" level="panel">
          <InboxConversation
            key={getSessionRenderKey(session) || id}
            sessionId={id}
            isIdle={session.is_idle}
            onSendAndAdvance={() => {}}
            onSendAndDismiss={handleSendAndDismiss}
            lastUserMessage={session.last_user_message}
            sessionError={session.session_error}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
});
