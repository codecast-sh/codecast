import { bridgeUserId, useInboxStore, type InboxSession, type ConversationMeta } from "./inboxStore";
import type { UserRest } from "@codecast/shared/contracts";
import { broadcastGesture } from "./gestureBridge";
import { pushUndo, showUndoToast } from "./undoStack";
import { declareViewNav } from "./viewNav";

/** Mark a session card to play the enter animation after it appears in the DOM. */
export function animateSessionEnter(id: string) {
  if (typeof document === "undefined") return;
  // Use setTimeout with escalating delays to wait for React to commit the render
  const delays = [0, 20, 50, 100, 200];
  const tryApply = (attempt: number) => {
    const card = document.querySelector(`[data-session-id="${id}"]`);
    const target = (card?.parentElement ?? card) as HTMLElement | null;
    if (target) {
      // Drive the collapse off the row's real rendered height (it may hold a
      // parent card plus subagent cards) so the keyframe never coasts on a short
      // row or clips a tall one — what the old hardcoded 80px cap did.
      target.style.setProperty('--row-h', `${target.offsetHeight}px`);
      target.classList.add('session-entering');
      target.addEventListener('animationend', () => {
        target.classList.remove('session-entering');
        target.style.removeProperty('--row-h');
      }, { once: true });
    } else if (attempt < delays.length - 1) {
      setTimeout(() => tryApply(attempt + 1), delays[attempt + 1]);
    }
  };
  setTimeout(() => tryApply(0), delays[0]);
}

export type HideSessionMode = "stash" | "kill";
/** `hidden` = "Stash and hide": the stash survives trigger wakes (stash mode only). */
export type HideSessionOpts = { hidden?: boolean };

/** Animate a session card sliding out, then call undoableHideSession. */
export function animatedHideSession(id: string, mode: HideSessionMode, opts?: HideSessionOpts) {
  const card = document.querySelector(`[data-session-id="${id}"]`);
  const wrapper = card?.parentElement;
  if (wrapper) {
    // Measure the real height (parent + any subagent rows) so the collapse
    // animates the whole stack, not just the first 80px the old cap allowed.
    wrapper.style.setProperty('--row-h', `${wrapper.offsetHeight}px`);
    wrapper.classList.add('session-dismissing');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      undoableHideSession(id, mode, opts);
    };
    wrapper.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 250);
  } else {
    undoableHideSession(id, mode, opts);
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

// Hide a session with undo. "stash" sets the session aside (agent keeps
// running); "kill" retires it (the server kills the agent on the hide
// transition). Undo restores the snapshot and clears BOTH hide flags — the
// kill itself isn't undoable (the session stays resumable), same as before.
export function undoableHideSession(id: string, mode: HideSessionMode, opts?: HideSessionOpts) {
  const state = useInboxStore.getState();
  const session = state.sessions[id];
  const label = session?.title || "session";
  const verb = mode === "kill" ? "Killed" : opts?.hidden ? "Stashed and hid" : "Stashed";
  const snap = snapshotSession(state, id);

  if (mode === "kill") useInboxStore.getState().killSession(id);
  else useInboxStore.getState().stashSession(id, opts);

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

      // User-invoked undo putting them back where they were at snapshot time.
      declareViewNav("undo");
      useInboxStore.setState({
        sessions: restoredSessions,
        conversations: restoredConvos,
        pending: restoredPending,
        currentSessionId: snap.currentSessionId,
        clientState: snap.clientState,
      });
      animateSessionEnter(id);
      // Push the SNAPSHOT flags, not blanket nulls: undoing a dismiss of a
      // session that was stashed at the time must land it back in Stashed.
      const restoredFlags = Object.fromEntries(
        snap.allIds.map((sid) => {
          const prev = snap.sessions[sid] ?? (snap.conversations[sid] as any);
          return [sid, {
            inbox_dismissed_at: prev?.inbox_dismissed_at ?? null,
            inbox_stashed_at: prev?.inbox_stashed_at ?? null,
            inbox_stash_hidden: prev?.inbox_stash_hidden ?? null,
          }];
        })
      );
      store.applyUndoPatches({
        conversations: restoredFlags,
        client_state: { _: { current_conversation_id: snap.currentSessionId } },
      });
      // killSession/stashSession announced the hide, so siblings now hold the
      // HIDDEN row; an un-announced undo leaves it there and that stale row
      // re-puts the undone hide into shared IDB, resurrecting it. A "fields"
      // message per id rather than a "restore": the snapshot is not always all
      // null (undoing a kill of a row that was stashed must land it back in
      // Stashed), so each id carries its own verbatim values — the same ones
      // applyUndoPatches dispatches, which is what lets the receiver's field
      // lock retire on the server echo. ONE timestamp for the whole gesture, so
      // the sibling's locks all key off the single undo. redo() re-hides
      // through kill/stashSession, which broadcast on their own.
      const ts = Date.now();
      for (const [sid, fields] of Object.entries(restoredFlags)) {
        broadcastGesture({ kind: "fields", id: sid, fields, ts }, bridgeUserId(store));
      }
      // Schedules the kill canceled come back with the session: the patch above
      // clears inbox_dismissed_at, and the server's un-hide transition
      // (dispatch.applyPatches) re-arms the stamped tasks authoritatively.
      // Redo re-kills through the hide transition, which re-cancels them.
    },
    redo: () => {
      if (mode === "kill") useInboxStore.getState().killSession(id);
      else useInboxStore.getState().stashSession(id, opts);
    },
  });

}

export const USER_REST_LABEL: Record<UserRest, string> = {
  needs_input: "Needs input",
  done: "Done",
  dormant: "Dormant",
};

// The fields one gesture stamps, named once. `session` is what the action
// writes on the session row (its derived twin included); `conversation` is the
// stamps the undo both restores locally and dispatches back to the server.
type GestureFields = {
  session: readonly string[];
  conversation: readonly string[];
};

// Absent reads back as null, never undefined: a field the gesture SET has to
// travel as an explicit tombstone or the dispatch drops it from the patch and
// the server keeps the value we are undoing.
function previousValues(row: Record<string, any> | undefined, fields: readonly string[]) {
  const prev: Record<string, any> = {};
  for (const field of fields) prev[field] = row?.[field] ?? null;
  return prev;
}

// Every triage gesture that stamps fields (defer, a rest verdict, pin) is the
// same four moves: snapshot the fields, stamp them, and offer an undo that puts
// them back on the session row, on the conversation meta and on the server,
// releasing the pending locks the stamp took. Only the field names, the label
// and the action itself differ, so those are the arguments — and `apply` is
// both the gesture and its redo, which is why they can never drift apart.
//
// Naming the fields in ONE place is also what keeps an undo honest: each of
// these actions clears a snooze on the way (clearSessionSnoozeInDraft), and the
// hand-written versions of defer and pin restored their own field while leaving
// the snooze cleared — undoing a gesture used to silently eat a snooze.
function undoableFieldGesture(
  id: string,
  fields: GestureFields,
  label: string,
  apply: () => void,
  afterUndo?: (store: StoreState) => void,
) {
  const state = useInboxStore.getState();
  const prevSession = previousValues(state.sessions[id], fields.session);
  const prevConversation = previousValues(state.conversations[id], fields.conversation);

  apply();

  pushUndo({
    label,
    undo: () => {
      const store = useInboxStore.getState();
      const sessions = { ...store.sessions };
      if (sessions[id]) sessions[id] = { ...sessions[id], ...prevSession };
      const conversations = { ...store.conversations };
      if (conversations[id]) conversations[id] = { ...conversations[id], ...prevConversation };
      const pending = { ...store.pending };
      for (const field of fields.session) delete pending[`sessions:${id}:${field}`];

      useInboxStore.setState({ sessions, conversations, pending });
      store.applyUndoPatches({ conversations: { [id]: prevConversation } });
      afterUndo?.(store);
    },
    redo: apply,
  });
}

const DEFER_FIELDS: GestureFields = {
  session: ["is_deferred", "inbox_deferred_at", "inbox_snoozed_until"],
  conversation: ["inbox_deferred_at", "inbox_snoozed_until"],
};

const REST_FIELDS: GestureFields = {
  session: ["user_rest", "inbox_rest", "inbox_rest_at", "inbox_snoozed_until"],
  conversation: ["inbox_rest", "inbox_rest_at", "inbox_snoozed_until"],
};

const PIN_FIELDS: GestureFields = {
  session: ["is_pinned", "inbox_pinned_at", "inbox_snoozed_until"],
  conversation: ["inbox_pinned_at", "inbox_snoozed_until"],
};

const sessionTitle = (id: string) => useInboxStore.getState().sessions[id]?.title || "session";

export function undoableDeferSession(id: string) {
  undoableFieldGesture(id, DEFER_FIELDS, `Defer ${sessionTitle(id)}`, () =>
    useInboxStore.getState().deferSession(id));
}

export function undoableSetSessionRest(id: string, rest: UserRest) {
  undoableFieldGesture(id, REST_FIELDS, `${USER_REST_LABEL[rest]} ${sessionTitle(id)}`, () =>
    useInboxStore.getState().setSessionRest(id, rest));
}

export function undoablePinSession(id: string) {
  const state = useInboxStore.getState();
  const wasPinned = !!state.sessions[id]?.is_pinned;
  const prevPinnedAt = state.conversations[id]?.inbox_pinned_at ?? null;

  undoableFieldGesture(
    id,
    PIN_FIELDS,
    wasPinned ? `Unpin ${sessionTitle(id)}` : `Pin ${sessionTitle(id)}`,
    () => useInboxStore.getState().pinSession(id),
    (store) => {
      // pinSession broadcast the flip, so a sibling now holds the PINNED row;
      // undoing without announcing leaves it there, and that stale row both
      // re-puts the undone pin into shared IDB and inverts the sibling's next
      // toggle (`!is_pinned` reads the value we just reverted). Carry the exact
      // restored inbox_pinned_at — the receiver's pending lock retires only
      // when the server echo matches it, and applyUndoPatches dispatches this
      // same value. redo() calls pinSession, which broadcasts on its own.
      broadcastGesture(
        { kind: "pin", id, pinned: wasPinned, pinnedAt: prevPinnedAt, ts: Date.now() },
        bridgeUserId(store),
      );
    },
  );
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
      store.restoreArchivedDoc(id);
    },
    redo: () => {
      useInboxStore.getState().archiveDoc(id);
    },
  });

  showUndoToast(`Archived ${label}`);
}
