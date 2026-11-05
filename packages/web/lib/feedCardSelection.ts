/**
 * Selection gestures on feed cards (hooks/useFeedCardTriage.tsx draws the rest):
 * a card whose conversation is one of your live inbox sessions ticks on
 * ⌘/ctrl-click and ranges on shift-click, in the feed's screen order, into the
 * shared inbox selection.
 */

import type React from "react";
import { useInboxStore } from "../store/inboxStore";
import { selectionGesture, useInboxSelection } from "./inboxSelection";
import { isSessionSetAside } from "./sessionRetirement";

/** The attribute every feed card carries: a shift-click ranges over them in DOM order. */
export const FEED_CARD_ATTR = "data-feed-card";

function liveSession(id: string) {
  const row = useInboxStore.getState().sessions[id];
  return row && !isSessionSetAside(row) ? row : null;
}

function feedOrder(): string[] {
  if (typeof document === "undefined") return [];
  return Array.from(document.querySelectorAll<HTMLElement>(`[${FEED_CARD_ATTR}]`))
    .map((el) => el.getAttribute(FEED_CARD_ATTR)!)
    .filter((id) => !!liveSession(id));
}

/** Handles a selection gesture on a card; true when the click was one, so the card must not open. */
export function feedCardSelect(id: string, e: React.MouseEvent): boolean {
  const gesture = selectionGesture(e);
  if (!gesture || !liveSession(id)) return false;
  e.preventDefault();
  const sel = useInboxSelection.getState();
  if (gesture === "toggle") sel.toggle(id);
  else sel.range(id, feedOrder());
  return true;
}

/** A plain click opens the card: it leaves selection mode and becomes the shift-range anchor. */
export function feedCardOpened(id: string): void {
  const sel = useInboxSelection.getState();
  if (sel.ids.length > 0) sel.set([], id);
  else useInboxSelection.setState({ anchorId: id });
}
