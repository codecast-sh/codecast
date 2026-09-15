"use client";
// The wake card wired to the org store: the role comes off the orgTree
// singleton (hooks/useSyncOrgTree feeds it, the card paints from the cache),
// the pause and resume ride the store's updateOrgRole action (optimistic; the
// dispatch side effect runs orgRoles.pause / resume), and the edit right is
// the scope page's own rule.
import { useCallback } from "react";
import { toast } from "sonner";
import { useSyncOrgTree } from "../hooks/useSyncOrgTree";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { canEditRole } from "../lib/scopePage";
import { RoleWakeCard } from "./RoleWakeCard";
import type { RoleWakeFrame } from "./roleWake";

export function RoleWakeBlock({ frame, timestamp }: { frame: RoleWakeFrame; timestamp?: number }) {
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
  return <RoleWakeCard frame={frame} timestamp={timestamp} now={now} role={role} canEdit={canEdit} onSetPaused={setPaused} />;
}
