import { useInboxStore, type InboxSession, type ConversationMeta } from "./inboxStore";
import { pushUndo, showUndoToast } from "./undoStack";

/** Mark a session card to play the enter animation after it appears in the DOM. */
export function animateSessionEnter(id: string) {
  // Use setTimeout with escalating delays to wait for React to commit the render
  const delays = [0, 20, 50, 100, 200];
  const tryApply = (attempt: number) => {
    const card = document.querySelector(`[data-session-id="${id}"]`);
    const target = card?.parentElement ?? card;
    if (target) {
      target.classList.add('session-entering');
      target.addEventListener('animationend', () => target.classList.remove('session-entering'), { once: true });
    } else if (attempt < delays.length - 1) {
      setTimeout(() => tryApply(attempt + 1), delays[attempt + 1]);
    }
  };
  setTimeout(() => tryApply(0), delays[0]);
}

/** Animate a session card sliding out, then call undoableStashSession. */
export function animatedStashSession(id: string, opts?: { verb?: string }) {
  const card = document.querySelector(`[data-session-id="${id}"]`);
  const wrapper = card?.parentElement;
  if (wrapper) {
    wrapper.classList.add('session-dismissing');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      undoableStashSession(id, opts);
    };
    wrapper.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 250);
  } else {
    undoableStashSession(id, opts);
  }
}

type StoreState = ReturnType<typeof useInboxStore.getState>;

function snapshotSession(state: StoreState, id: string) {
  const sessionValues = Object.values(state.sessions) as InboxSession[];
  const childIds = sessionValues
    .filter((s) => s.parent_conversation_id === id)
    .map((s) => s._id);
  const allIds = [id, ...childIds];

  const sessions: Record<string, InboxSession> = {};
  const conversations: Record<string, ConversationMeta> = {};
  const pending: Record<string, any> = {};

  for (const sid of allIds) {
    if (state.sessions[sid]) sessions[sid] = { ...state.sessions[sid] };
    if (state.conversations[sid]) conversations[sid] = { ...state.conversations[sid] };
    for (const key of Object.keys(state.pending)) {
      if (key.startsWith(`sessions:${sid}`)) pending[key] = state.pending[key];
    }
  }

  return {
    allIds,
    sessions,
    conversations,
    pending,
    currentSessionId: state.currentSessionId,
    clientState: { ...state.clientState },
  };
}

export function undoableStashSession(id: string, options?: { verb?: string }) {
  const state = useInboxStore.getState();
  const session = state.sessions[id];
  const label = session?.title || "session";
  const verb = options?.verb || "Dismissed";
  const snap = snapshotSession(state, id);

  const isKill = verb === "Killed";
  useInboxStore.getState().stashSession(id, isKill ? { kill: true } : undefined);

  pushUndo({
    label: `${verb} ${label}`,
    undo: () => {
      const store = useInboxStore.getState();
      const restoredSessions = { ...store.sessions };
      const restoredConvos = { ...store.conversations };
      const restoredPending = { ...store.pending };

      for (const sid of snap.allIds) {
        if (snap.sessions[sid]) restoredSessions[sid] = snap.sessions[sid];
        if (snap.conversations[sid]) restoredConvos[sid] = snap.conversations[sid];
        delete restoredPending[`sessions:${sid}`];
      }
      for (const [key, val] of Object.entries(snap.pending)) {
        restoredPending[key] = val;
      }

      useInboxStore.setState({
        sessions: restoredSessions,
        conversations: restoredConvos,
        pending: restoredPending,
        currentSessionId: snap.currentSessionId,
        clientState: snap.clientState,
      });
      animateSessionEnter(id);
      store._dispatch("patch", [], {
        conversations: Object.fromEntries(
          snap.allIds.map((sid) => [sid, { inbox_dismissed_at: null }])
        ),
        client_state: { _: { current_conversation_id: snap.currentSessionId } },
      }).catch(() => {});
    },
    redo: () => {
      useInboxStore.getState().stashSession(id);
    },
  });

}

export function undoableDeferSession(id: string) {
  const state = useInboxStore.getState();
  const session = state.sessions[id];
  const label = session?.title || "session";
  const wasDeferred = session?.is_deferred;
  const prevConvo = state.conversations[id]
    ? { ...state.conversations[id] }
    : null;

  useInboxStore.getState().deferSession(id);

  pushUndo({
    label: `Defer ${label}`,
    undo: () => {
      const store = useInboxStore.getState();
      const newSessions = { ...store.sessions };
      if (newSessions[id]) {
        newSessions[id] = { ...newSessions[id], is_deferred: wasDeferred };
      }
      const newConvos = { ...store.conversations };
      if (prevConvo) {
        newConvos[id] = prevConvo;
      }
      const newPending = { ...store.pending };
      delete newPending[`sessions:${id}:is_deferred`];

      useInboxStore.setState({
        sessions: newSessions,
        conversations: newConvos,
        pending: newPending,
      });
      store._dispatch("patch", [], {
        conversations: { [id]: { inbox_deferred_at: prevConvo?.inbox_deferred_at ?? null } },
      }).catch(() => {});
    },
    redo: () => {
      useInboxStore.getState().deferSession(id);
    },
  });
}

export function undoablePinSession(id: string) {
  const state = useInboxStore.getState();
  const session = state.sessions[id];
  const label = session?.title || "session";
  const wasPinned = session?.is_pinned;
  const prevPinnedAt = state.conversations[id]?.inbox_pinned_at ?? null;

  useInboxStore.getState().pinSession(id);

  const actionLabel = wasPinned ? `Unpin ${label}` : `Pin ${label}`;

  pushUndo({
    label: actionLabel,
    undo: () => {
      const store = useInboxStore.getState();
      const newSessions = { ...store.sessions };
      if (newSessions[id]) {
        newSessions[id] = { ...newSessions[id], is_pinned: wasPinned };
      }
      const newConvos = { ...store.conversations };
      if (newConvos[id]) {
        newConvos[id] = { ...newConvos[id], inbox_pinned_at: prevPinnedAt };
      }
      const newPending = { ...store.pending };
      delete newPending[`sessions:${id}:is_pinned`];

      useInboxStore.setState({
        sessions: newSessions,
        conversations: newConvos,
        pending: newPending,
      });
      store._dispatch("patch", [], {
        conversations: { [id]: { inbox_pinned_at: prevPinnedAt } },
      }).catch(() => {});
    },
    redo: () => {
      useInboxStore.getState().pinSession(id);
    },
  });
}

export function undoableRenameSession(id: string, title: string) {
  const state = useInboxStore.getState();
  const prevTitle = state.sessions[id]?.title || "";

  useInboxStore.getState().renameSession(id, title);

  pushUndo({
    label: `Rename to ${title}`,
    undo: () => {
      useInboxStore.getState().renameSession(id, prevTitle);
    },
    redo: () => {
      useInboxStore.getState().renameSession(id, title);
    },
  });
}

export function undoableArchiveDoc(id: string) {
  const state = useInboxStore.getState();
  const doc = state.docs[id];
  const detail = state.docDetails[id];
  if (!doc) return;

  const label = doc.title || "document";
  const docSnap = { ...doc };
  const detailSnap = detail ? { ...detail } : null;

  useInboxStore.getState().archiveDoc(id);

  pushUndo({
    label: `Archive ${label}`,
    undo: () => {
      const store = useInboxStore.getState();
      const newDocs = { ...store.docs, [id]: docSnap };
      const newDetails = { ...store.docDetails };
      if (detailSnap) newDetails[id] = detailSnap;

      useInboxStore.setState({ docs: newDocs, docDetails: newDetails });
      store._dispatch("patch", [], {
        docs: { [id]: { archived_at: null } },
      }).catch(() => {});
    },
    redo: () => {
      useInboxStore.getState().archiveDoc(id);
    },
  });

  showUndoToast(`Archived ${label}`);
}
