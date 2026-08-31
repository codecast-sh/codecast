"use client";

import { useCallback, useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { overlayConversationId } from "../../store/workspace";
import {
  animatedHideSession,
  undoableDeferSession,
  undoableDormantSession,
  undoablePinSession,
} from "../../store/undoActions";
import { useTriggerKillNotice } from "../../hooks/useTriggerKillNotice";
import { checkMilestone } from "../../tips/useTips";
import { noteTriageKeyUse } from "./graduation";

export type TriageSource = "key" | "button";

// One implementation of the triage verbs, shared by the keyboard chords
// (shortcuts/actions.ts) and the triage bar's buttons. The two surfaces must
// never diverge: whatever a chord does to the focused row, the button does to
// the viewed row, including the advance to the next card, the fleet drill-in
// close, and the first-use milestones.
export function useTriageActions(isOnInboxPage: boolean) {
  // A triage verb that removes the row from its band finishes by closing the
  // fleet drill-in when it was the target: the board behind it is what shows
  // the result (the tile moves bands), and leaving the just-parked
  // conversation on top would hide exactly that. Returns true when it closed
  // one — that IS the advance for the board (setCurrentSession would leave
  // the board for the next row's conversation page).
  const closeOverlayIfCurrent = useCallback((id: string): boolean => {
    const store = useInboxStore.getState();
    if (overlayConversationId(store.workspace) !== id) return false;
    store.wsHide("secondary", { remember: false });
    return true;
  }, []);

  // Shared body of stash/kill; the only difference is the mode. The kill
  // itself happens SERVER-side on the hide data transition
  // (dispatch.applyPatches), so neither caller asks for it. The kill routes
  // through the notice hook so it names any schedules the kill cancels.
  const { killWithNotice } = useTriggerKillNotice();
  const hide = useCallback((id: string, mode: "stash" | "kill", source: TriageSource = "key") => {
    const store = useInboxStore.getState();
    if (mode === "stash") checkMilestone("m-first-stash");
    if (!isOnInboxPage) {
      const ordered = store.visualOrder();
      const idx = ordered.findIndex((s) => s._id === id);
      const next = ordered.slice(idx + 1).find((s) => s._id !== id)
        ?? ordered.find((s) => s._id !== id);
      if (next) store.selectPanelSession(next._id);
    }
    if (mode === "kill") killWithNotice(id);
    else animatedHideSession(id, mode);
    closeOverlayIfCurrent(id);
    if (source === "key") noteTriageKeyUse();
  }, [isOnInboxPage, killWithNotice, closeOverlayIfCurrent]);

  // Defer and dormant share one shape: stamp the row, then advance the
  // selection to the next row in visual order (computed BEFORE the stamp —
  // stamping reorders the list).
  const park = useCallback((id: string, verb: "defer" | "dormant", source: TriageSource = "key") => {
    const store = useInboxStore.getState();
    const ordered = store.visualOrder();
    const idx = ordered.findIndex((s) => s._id === id);
    const next = ordered[idx + 1] ?? ordered.find((s) => s._id !== id);
    if (verb === "defer") undoableDeferSession(id);
    else undoableDormantSession(id);
    if (!closeOverlayIfCurrent(id) && next) {
      if (isOnInboxPage) store.setCurrentSession(next._id);
      else store.selectPanelSession(next._id);
    }
    if (source === "key") noteTriageKeyUse();
  }, [isOnInboxPage, closeOverlayIfCurrent]);

  const pin = useCallback((id: string) => {
    const session = useInboxStore.getState().sessions[id];
    if (session && !session.is_pinned) checkMilestone("m-first-pin");
    undoablePinSession(id);
  }, []);

  const label = useCallback((id: string) => {
    const store = useInboxStore.getState();
    const session = store.sessions[id];
    if (session) store.openPalette({ targets: [session], targetType: "session", mode: "bucket" });
  }, []);

  return useMemo(() => ({ hide, park, pin, label, closeOverlayIfCurrent }),
    [hide, park, pin, label, closeOverlayIfCurrent]);
}
