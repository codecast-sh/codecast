"use client";
// One conversation, hosted as a pane: a split-stage cell, or an inline reveal
// band inside another conversation (components/ObjectReveal). The host owns
// what close and expand DO — the stage closes the leaf / takes the stage, the
// reveal collapses the band / opens the session — so both arrive as
// callbacks. It subscribes to the few fields of this session's row it passes
// on, never the whole row or the whole map.

import { lazy, memo, Suspense, useCallback, useMemo } from "react";
import { useTrackedStore, useInboxStore, getSessionRenderKey } from "../../store/inboxStore";
import { animatedHideSession } from "../../store/undoActions";
import { useMissingSessionLookup } from "../../hooks/useMissingSessionRow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ConversationPlaceholder } from "../ConversationPlaceholder";
import { ConversationUnavailable } from "../ConversationUnavailable";
import { ErrorBoundary } from "../ErrorBoundary";
import { PaneControls } from "./PaneControls";

// Loaded on first use: the conversation renderer lives in the inbox page's
// module, and pulling it in at import time would hang the whole inbox off
// TabContent's import graph for every tab, split or not. SessionPage is what
// opening a session renders anywhere (initiatives-projects-role-page.md I3):
// a role's standing session is the role page here too, with the pane's own
// expand and close controls kept in its header.
const SessionPage = lazy(() =>
  import("../../app/inbox/QueuePageClient").then((m) => ({ default: m.SessionPage })),
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
  // Only the fields this pane passes on: the row's identity flips on every
  // liveness beat (about once a second while its agent works), and a wake
  // here rebuilds the whole conversation under it.
  const s = useTrackedStore([
    (st) => getSessionRenderKey(st.sessions[sessionId]),
    (st) => st.sessions[sessionId]?.is_idle,
    (st) => st.sessions[sessionId]?.last_user_message,
    (st) => st.sessions[sessionId]?.session_error,
    (st) => st.pending[`sessions:${sessionId}`]?.type === "exclude",
  ]);
  const session = s.sessions[sessionId] ?? null;
  const killed = s.pending[`sessions:${sessionId}`]?.type === "exclude";
  // A row the store does not hold (a teammate's session, one outside the inbox
  // window) loads here and lands in the store; the pane then paints from it.
  const { row: missing, failed } = useMissingSessionLookup(session || killed ? null : sessionId);
  useWatchEffect(() => {
    if (missing) useInboxStore.getState().seedSession(missing);
  }, [missing]);
  // Stable, so the memoized conversation below holds across this pane's renders.
  const onSendAndDismiss = useCallback(() => animatedHideSession(sessionId, "stash"), [sessionId]);
  const headerEnd = useMemo(
    () => (onClose || onExpand ? <PaneControls onExpand={onExpand} onClose={onClose} /> : undefined),
    [onClose, onExpand],
  );
  if (!session) {
    if (!killed && missing !== null) return <ConversationPlaceholder id={sessionId} />;
    // Killed here, or the server will not hand it over (deleted, private):
    // say so honestly instead of painting an empty column.
    return <ConversationUnavailable failed={!killed && failed} actionLabel={onClose ? "Close pane" : undefined} onAction={onClose} />;
  }
  return (
    <ErrorBoundary name="StageSessionPane" level="panel">
      <Suspense fallback={null}>
        <SessionPage
          key={getSessionRenderKey(session) || sessionId}
          sessionId={sessionId}
          isIdle={session.is_idle}
          onSendAndAdvance={noop}
          onSendAndDismiss={onSendAndDismiss}
          lastUserMessage={session.last_user_message}
          sessionError={session.session_error}
          targetMessageId={targetMessageId}
          headerEnd={headerEnd}
        />
      </Suspense>
    </ErrorBoundary>
  );
});
