"use client";
import { memo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Maximize2, X } from "lucide-react";
import { useTrackedStore, useInboxStore, getSessionRenderKey } from "../store/inboxStore";
import { companionId } from "../store/workspace";
import { InboxConversation } from "./GlobalSessionPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { animatedHideSession } from "../store/undoActions";
import { SlotPanel } from "./workspace/Slot";

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
    (st) => companionId(st.workspace),
    // Only this row is read — subscribing to the whole map would re-render the
    // companion on every other session's heartbeat.
    (st) => st.sessions[companionId(st.workspace) ?? ""],
  ]);
  const router = useRouter();
  const id = companionId(s.workspace);
  const session = id ? (s.sessions[id] ?? null) : null;

  const handleClose = useCallback(() => {
    // remember:true — a close by hand is sticky (see hidePane).
    useInboxStore.getState().wsHide("secondary", { remember: true });
  }, []);

  const handleExpand = useCallback(() => {
    if (!id) return;
    // ⤢ is promote: the conversation takes the stage.
    const store = useInboxStore.getState();
    store.wsHide("secondary", { remember: false });
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
    // The full panel frame: same header, same controls, same edges as every
    // other slot — this is what makes the system visible rather than internal.
    <SlotPanel
      slot="secondary"
      title={session.title || "Session"}
      canPromote
      onPromote={handleExpand}
      className="border-l border-sol-border/30"
    >
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
    </SlotPanel>
  );
});
