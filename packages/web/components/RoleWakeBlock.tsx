"use client";
// The wake card wired to the org store: the role comes off the orgTree
// singleton (hooks/useSyncOrgTree feeds it, the card paints from the cache),
// the pause and resume ride the store's updateOrgRole action (optimistic; the
// dispatch side effect runs orgRoles.pause / resume), and the edit right is
// the scope page's own rule.
//
// Where the message went (scopes-and-feed.md F4.2) is derived here from rows,
// never from the role's prose: the standing session's hands (one live query
// per conversation, shared by every card on it) cut to this turn's window,
// and the `cast send` targets the view read off the turn's tool calls.
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useSyncOrgTree } from "../hooks/useSyncOrgTree";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useHandsStartedBy } from "../hooks/useHandsStartedBy";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { canEditRole } from "../lib/scopePage";
import { RoleWakeCard, type RoleWakeRouting } from "./RoleWakeCard";
import { handsStartedInTurn, type RoleWakeFrame } from "./roleWake";

export type RoleWakeBlockProps = {
  frame: RoleWakeFrame;
  timestamp?: number;
  /** The standing session this frame landed in. */
  conversationId?: string;
  /** The next turn boundary after this wake; null when this is the latest turn. */
  until?: number | null;
  /** Sessions the role ran `cast send` to in this turn. */
  sentTo?: string[];
  /** Only where the message went (RoleWakeCard routingOnly). */
  routingOnly?: boolean;
};

const NO_SENT_TO: string[] = [];

export function RoleWakeBlock({ frame, timestamp, conversationId, until = null, sentTo = NO_SENT_TO, routingOnly }: RoleWakeBlockProps) {
  const { tree } = useSyncOrgTree();
  const now = useCoarseNow(30_000);
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;
  const role = tree?.roles.find((r) => r.short_id === frame.roleShortId) ?? null;
  const canEdit = canEditRole(tree, role, meId);
  const setPaused = useCallback((paused: boolean) => {
    if (!role) return;
    useInboxStore.getState().updateOrgRole(role._id, { status: paused ? "paused" : "active" });
    toast.success(paused ? `Paused ${role.name}: wakes hold until you resume` : `Resumed ${role.name}: held wakes ship as one frame`);
  }, [role]);
  const hands = useHandsStartedBy(conversationId);
  const at = frame.at ?? (timestamp && timestamp > 0 ? timestamp : null);
  const routing = useMemo<RoleWakeRouting>(() => ({ hands: handsStartedInTurn(hands, at, until), sentTo }), [hands, at, until, sentTo]);
  return <RoleWakeCard frame={frame} timestamp={timestamp} now={now} role={role} canEdit={canEdit} onSetPaused={setPaused} routing={routing} routingOnly={routingOnly} />;
}
