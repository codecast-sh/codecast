"use client";
import { memo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Maximize2, X } from "lucide-react";
import { useTrackedStore, useInboxStore, getSessionRenderKey } from "../store/inboxStore";
import { companionId } from "../store/workspace";
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

  // A companion whose row vanished (killed, pruned). Rendering null here is
  // only a same-commit stopgap: the layout collapses the panel and the mirror
  // closes the slot (companionMirrorStep) — an expanded panel around a null
  // render is the empty-column bug.
  if (!id || !session) return null;

  return (
    // NO wrapper header here: ConversationView already renders one, and it
    // already hosts close/expand. Adding SlotPanel on top printed the session
    // title twice in two stacked bars. The conversation's own header IS this
    // panel's header.
    <div className="h-full flex flex-col border-l border-sol-border/30 bg-sol-bg">
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
            onExpandToMain={handleExpand}
            onClose={handleClose}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
});
