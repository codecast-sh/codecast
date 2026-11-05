"use client";

/**
 * Inbox triage on a feed card. A card whose conversation is one of your live
 * inbox sessions works like the inbox panel's card: ⌘/ctrl-click ticks it,
 * shift-click ticks the run since the last tick (in the feed's screen order),
 * right-click opens the session menu, and hovering shows Kill and Stash. The
 * ticks land in the shared inbox selection, so the panel's selection bar acts
 * on them. Any other card (a teammate's, or one already set aside) opens on
 * every click, as before.
 */

import { createContext, useContext } from "react";
import type React from "react";
import { useInboxStore } from "../store/inboxStore";
import { animatedHideSessions } from "../store/undoActions";
import { selectionIdsFor, useInboxSelection } from "../lib/inboxSelection";
import { isSessionSetAside } from "../lib/sessionRetirement";
import { useTriggerKillNotice } from "./useTriggerKillNotice";
import { ContextMenu, useContextMenu } from "../components/ui/context-menu";
import { SessionMenuItems } from "../components/menus/ObjectContextMenus";
import { BulkSessionMenuItems } from "../components/BulkMoveSessions";
import { CardHoverToolbar } from "../components/inbox/SessionCardParts";

/** True where a card's conversation is never the viewer's own session (the homepage hero's fixtures): no triage, no tick. */
export const FeedTriageOff = createContext(false);

export function useFeedCardTriage(id: string, own: boolean, open: () => void) {
  const off = useContext(FeedTriageOff);
  // Primitives only: a heartbeat on the row must not re-render the card.
  const triageable = useInboxStore((s) => {
    const row = s.sessions[id];
    return !off && own && !!row && !isSessionSetAside(row);
  });
  const ticked = useInboxSelection((sel) => !off && sel.ids.includes(id));
  const menu = useContextMenu<null>();
  if (!triageable) return { ticked: false, onContextMenu: undefined, overlay: null };
  const session = useInboxStore.getState().sessions[id]!;
  const overlay = (
    <>
      <CardHoverToolbar
        session={session}
        labels={false}
        fadeGround="var(--sol-card-hover)"
        onDismiss={() => { void animatedHideSessions(selectionIdsFor(id), "kill"); }}
        onStash={() => { void animatedHideSessions(selectionIdsFor(id), "stash"); }}
      />
      <ContextMenu state={menu}>{() => <FeedCardMenu id={id} open={open} />}</ContextMenu>
    </>
  );
  return { ticked, onContextMenu: (e: React.MouseEvent) => menu.open(e, null), overlay };
}

// Mounted only while the menu is open, so the trigger-notice subscription
// costs nothing per card.
function FeedCardMenu({ id, open }: { id: string; open: () => void }) {
  const { killWithNotice, killManyWithNotice } = useTriggerKillNotice();
  const store = useInboxStore.getState();
  const sessions = selectionIdsFor(id).map((x) => store.sessions[x]).filter((row) => !!row);
  const clear = () => useInboxSelection.getState().clear();
  if (sessions.length > 1) {
    return (
      <BulkSessionMenuItems
        sessions={sessions}
        onStash={(ids) => { void animatedHideSessions(ids, "stash"); }}
        onKill={killManyWithNotice}
        onClear={clear}
      />
    );
  }
  const session = sessions[0];
  if (!session) return null;
  return (
    <SessionMenuItems
      session={session}
      onOpen={open}
      onStash={() => { void animatedHideSessions([id], "stash"); }}
      onKill={() => killWithNotice(id)}
      onRename={() => store.openSessionRename(session)}
    />
  );
}
