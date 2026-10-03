"use client";
// The undo timeline, connected (docs/architecture/undo-history.md S8). The
// engine's history (hooks/useUndoHistory) and the store's live titles feed
// the pure row model (lib/undoHistory); every act goes back to the engine
// (undoTo / redoTo) or opens a place through the recents path.
//
// UndoTimelineHost mounts beside RecentSwitcherHost and renders nothing until
// a doorway opens the card (lib/undoTimelineOpen): the palette row, the chord,
// the "Undid" toast's History action, the held peek.
import { useCallback, useMemo, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../../store/inboxStore";
import { redoTo, undoTo } from "../../store/undoStack";
import * as undoTimeline from "../../lib/undoTimelineOpen";
import { ORG_RECORD_PATH, undoFixtureWalk, undoHistoryFixture, undoObjectsSig, undoTimelineRows } from "../../lib/undoHistory";
import { useUndoHistory } from "../../hooks/useUndoHistory";
import { useOpenSession } from "../../hooks/useOpenSession";
import { useOpenRecentVisit } from "../../hooks/useOpenRecentVisit";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { getShortcutsForAction, matchShortcut, useShortcuts, type ShortcutAction } from "../../shortcuts";
import { orgPreviewEnabled } from "../org/staffingModel";
import { UndoTimelineView, type UndoTimelineViewProps } from "./UndoTimelineView";
import type { ResolvedVisit } from "../../lib/recentVisits";

/** The chords that keep working while focus is inside the card. The card
 *  owns its plain keys (data-owns-keys), so these are handed on by name. */
const CARD_CHORDS: ShortcutAction[] = ["ui.undo", "ui.redo", "ui.undoHistory"];

function useCardChords(): (e: ReactKeyboardEvent) => boolean {
  const { dispatchAction } = useShortcuts();
  return useCallback((e: ReactKeyboardEvent) => {
    for (const action of CARD_CHORDS) {
      const def = getShortcutsForAction(action).find((d) => matchShortcut(e.nativeEvent, d));
      if (!def) continue;
      e.preventDefault();
      if (!(def.noRepeat && e.repeat)) dispatchAction(action);
      return true;
    }
    return false;
  }, [dispatchAction]);
}

/** Opening a place, the org record, closing: shared by the live card and the preview. */
function useCardActs(): Pick<UndoTimelineViewProps, "onOpen" | "onOpenOrg" | "onClose" | "onKey"> {
  const router = useRouter();
  const openSession = useOpenSession();
  const openVisit = useOpenRecentVisit(openSession);
  // close() hands focus back to whatever held it before the card opened.
  const onClose = useCallback(() => undoTimeline.close(), []);
  const onOpen = useCallback((visit: ResolvedVisit) => { undoTimeline.close(); openVisit(visit); }, [openVisit]);
  const onOpenOrg = useCallback(() => { undoTimeline.close(); router.push(ORG_RECORD_PATH); }, [router]);
  const onKey = useCardChords();
  return { onOpen, onOpenOrg, onClose, onKey };
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
  // Keyed on the mode: a peek pinned interactive remounts and takes focus.
  return preview ? <UndoTimelinePreview key={state.mode} mode={state.mode} /> : <UndoTimeline key={state.mode} mode={state.mode} />;
}

