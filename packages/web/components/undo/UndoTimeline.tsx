"use client";
// The undo timeline, connected (docs/architecture/undo-history.md S8). The
// engine's history (hooks/useUndoHistory) and the store's live titles feed
// the pure row model (lib/undoHistory); every act goes back to the engine
// (undoTo / redoTo) or opens a place through the recents path.
//
// UndoTimelineHost mounts beside RecentSwitcherHost and renders nothing until
// a doorway opens the card (lib/undoTimelineOpen): the palette row, the chord,
// the "Undid" toast's History action, the held peek.
import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../../store/inboxStore";
import { redoTo, undoTo } from "../../store/undoStack";
import * as undoTimeline from "../../lib/undoTimelineOpen";
import { ORG_RECORD_PATH, undoFixtureWalk, undoHistoryFixture, undoObjectsSig, undoTimelineRows } from "../../lib/undoHistory";
import { useUndoHistory } from "../../hooks/useUndoHistory";
import { useOpenSession } from "../../hooks/useOpenSession";
import { useOpenRecentVisit } from "../../hooks/useOpenRecentVisit";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { getShortcutsForAction, matchShortcut, useShortcuts } from "../../shortcuts";
import { UNDO_CARD_CHORDS } from "../../shortcuts/keyOwnership";
import { orgPreviewEnabled } from "../org/staffingModel";
import { UndoTimelineView, type UndoTimelineViewProps } from "./UndoTimelineView";
import { useUndoWalk } from "../../hooks/useUndoWalk";
import type { ResolvedVisit } from "../../lib/recentVisits";


function useCardChords(): (e: KeyboardEvent) => boolean {
  const { dispatchAction } = useShortcuts();
  return useCallback((e: KeyboardEvent) => {
    for (const action of UNDO_CARD_CHORDS) {
      const def = getShortcutsForAction(action).find((d) => matchShortcut(e, d));
      if (!def) continue;
      e.preventDefault();
      if (!(def.noRepeat && e.repeat)) dispatchAction(action);
      return true;
    }
    return false;
  }, [dispatchAction]);
}

/**
 * Where the card's open acts lead in the frame that mounts it. The dashboard's
 * (the default) opens sessions through its inbox and pages in its tabs. A
 * frame outside the dashboard (the simple lane, the standalone /r pages)
 * passes its own through UndoReach, because the dashboard's openers assume its
 * tab shell. `openVisit` answers null where the frame has no place for the
 * object: that row shows no title link and O does nothing. `openOrg` null =
 * the frame has no org record, so org rows are inert there.
 */
export type UndoCardFrame = {
  openVisit: (visit: ResolvedVisit) => (() => void) | null;
  openOrg: (() => void) | null;
};

const UndoFrameContext = createContext<UndoCardFrame | null>(null);

function useDashboardFrame(): UndoCardFrame {
  const router = useRouter();
  const openSession = useOpenSession();
  const openVisit = useOpenRecentVisit(openSession);
  return useMemo(() => ({ openVisit: (visit) => () => openVisit(visit), openOrg: () => router.push(ORG_RECORD_PATH) }), [openVisit, router]);
}

type CardActs = Pick<UndoTimelineViewProps, "onOpen" | "canOpen" | "onOpenOrg" | "onClose" | "onKey">;

/** Opening a place, the org record, closing: shared by the live card and the preview. */
function useCardActs(): CardActs {
  const dashboard = useDashboardFrame();
  const frame = useContext(UndoFrameContext) ?? dashboard;
  // close() hands focus back to whatever held it before the card opened.
  const onClose = useCallback(() => undoTimeline.close(), []);
  const canOpen = useCallback((visit: ResolvedVisit) => !!frame.openVisit(visit), [frame]);
  const onOpen = useCallback((visit: ResolvedVisit) => {
    const go = frame.openVisit(visit);
    if (!go) return;
    undoTimeline.close();
    go();
  }, [frame]);
  const openOrg = frame.openOrg;
  const onOpenOrg = useMemo(() => (openOrg ? () => { undoTimeline.close(); openOrg(); } : null), [openOrg]);
  const onKey = useCardChords();
  return { onOpen, canOpen, onOpenOrg, onClose, onKey };
}

export function UndoTimeline({ mode }: { mode: undoTimeline.UndoTimelineMode }) {
  const { snapshot, now, windowMs } = useUndoHistory();
  // Wake on what the rows paint (each object's presence and name), not on
  // every heartbeat that touches a session row.
  const objectsSig = useInboxStore((s) => undoObjectsSig(s, snapshot));
  const model = useMemo(
    () => undoTimelineRows(snapshot, useInboxStore.getState(), now, windowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- objectsSig is the store dependency
    [snapshot, now, windowMs, objectsSig],
  );
  const acts = useCardActs();
  const onUndoTo = useCallback((id: string) => { undoTo(id); }, []);
  const onRedoTo = useCallback((id: string) => { redoTo(id); }, []);
  const flash = useSyncExternalStore(undoTimeline.subscribeFlash, undoTimeline.getFlash, undoTimeline.getFlash);
  return <UndoTimelineView model={model} mode={mode} onUndoTo={onUndoTo} onRedoTo={onRedoTo} flash={flash} {...acts} />;
}

/**
 * The DEV preview (`?preview=1` on a route that keeps its query, e.g.
 * `/tasks?preview=1`; `/inbox` redirects and drops it): the fixture's every row state, with the
 * walk kept in local state so Back and Forward move the head with no store.
 */
export function UndoTimelinePreview({ mode }: { mode: undoTimeline.UndoTimelineMode }) {
  const now = useCoarseNow(60_000);
  const fixture = useMemo(() => undoHistoryFixture(Date.now()), []);
  const [head, setHead] = useState(fixture.snapshot.head);
  // Walk the fixture like the engine walks its stacks; rows off the stacks
  // (an org row, a refusal, a manual entry past the window) never move.
  const snapshot = useMemo(() => undoFixtureWalk(fixture.snapshot.items, head, Date.now()), [fixture, head]);
  const model = useMemo(() => undoTimelineRows(snapshot, fixture.state, now), [snapshot, fixture, now]);
  const acts = useCardActs();
  // Back to a row makes the next entry down the undo stack the head.
  const onUndoTo = useCallback((id: string) => {
    const at = snapshot.undoOrder.indexOf(id);
    if (at !== -1) setHead(snapshot.undoOrder[at + 1] ?? null);
  }, [snapshot]);
  const onRedoTo = useCallback((id: string) => setHead(id), []);
  return <UndoTimelineView model={model} mode={mode} onUndoTo={onUndoTo} onRedoTo={onRedoTo} {...acts} />;
}

/** Renders nothing until a doorway opens the card. */
export function UndoTimelineHost() {
  const state = useSyncExternalStore(undoTimeline.subscribe, undoTimeline.getSnapshot, undoTimeline.getSnapshot);
  if (!state.open) return null;
  // Read per render, so an in-app navigation that drops the flag drops the fixture.
  const preview = typeof window !== "undefined" && orgPreviewEnabled(window.location.search, !!import.meta.env.DEV);
  // Not keyed on the mode: a peek pinned by a press on it turns interactive in
  // place (the view takes focus then), so the press's click still lands on
  // the row button it was aimed at.
  return preview ? <UndoTimelinePreview mode={state.mode} /> : <UndoTimeline mode={state.mode} />;
}


/** Both halves of a frame's way back to its history, for a frame outside the
 *  dashboard (which mounts them itself): the keys and the held peek
 *  (useUndoWalk) and the card a toast's History opens. `frame` says where the
 *  card's open acts lead there; without one they open the full app. */
export function UndoReach({ frame }: { frame?: UndoCardFrame }) {
  useUndoWalk();
  return <UndoFrameContext.Provider value={frame ?? null}><UndoTimelineHost /></UndoFrameContext.Provider>;
}
