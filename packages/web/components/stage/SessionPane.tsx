"use client";
// One conversation, hosted as a pane: a split-stage cell, or an inline reveal
// band inside another conversation (components/ObjectReveal). The host owns
// what close and expand DO — the stage closes the leaf / takes the stage, the
// reveal collapses the band / opens the session — so both arrive as
// callbacks. The row subscription is only this session's row, never the whole
// map.

import { lazy, memo, Suspense } from "react";
import { useTrackedStore, getSessionRenderKey } from "../../store/inboxStore";
import { animatedHideSession } from "../../store/undoActions";
import { ErrorBoundary } from "../ErrorBoundary";

// Loaded on first use: the conversation renderer lives in the session-panel
// module, and pulling it in at import time would hang the whole panel (and
// its analytics) off TabContent's import graph for every tab, split or not.
const InboxConversation = lazy(() =>
  import("../GlobalSessionPanel").then((m) => ({ default: m.InboxConversation })),
);

const noop = () => {};

export const SessionPane = memo(function SessionPane({
  sessionId,
  onClose,
  onExpand,
  targetMessageId,
}: {
  sessionId: string;
  onClose?: () => void;
  onExpand?: () => void;
  /** A `#msg-<id>` deep link: the pane opens scrolled to that message. */
  targetMessageId?: string;
}) {
  const s = useTrackedStore([(st) => st.sessions[sessionId]]);
  const session = s.sessions[sessionId] ?? null;
  if (!session) {
    // A pane for a row the store no longer holds (killed, pruned): say so
    // honestly instead of painting an empty column.
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-sol-text-dim">
        <span>This session is no longer available</span>
        {onClose && (
          <button onClick={onClose} className="text-sol-cyan hover:underline">Close pane</button>
        )}
      </div>
    );
  }
  return (
    <ErrorBoundary name="StageSessionPane" level="panel">
      <Suspense fallback={null}>
        <InboxConversation
          key={getSessionRenderKey(session) || sessionId}
          sessionId={sessionId}
          isIdle={session.is_idle}
          onSendAndAdvance={noop}
          onSendAndDismiss={() => animatedHideSession(sessionId, "stash")}
          lastUserMessage={session.last_user_message}
          sessionError={session.session_error}
          targetMessageId={targetMessageId}
          onExpandToMain={onExpand}
          onClose={onClose}
        />
      </Suspense>
    </ErrorBoundary>
  );
});
