import { useMemo } from "react";
import { useInboxStore, type InboxSession } from "../store/inboxStore";
import type { TriggerRow } from "../components/triggerTasks";
import type { RowActivity } from "../components/inbox/ActivityLine";
import { dormantSplitSig, rowActivity } from "../lib/railActivity";
import { useWatchEffect } from "./useWatchEffect";
import { useMountEffect } from "./useMountEffect";

/**
 * The Dormant bucket, split for display by what each row is really doing
 * (lib/railActivity over the shared sessionActivity): its own work running
 * draws under Working, its change on the way to live under Shipping, and only
 * a wait stays in Sleeping. Placement is untouched. The keyboard walk reads the
 * same split, published here (setDormantSplitNav). The panel wakes on the
 * split's own signature (each Dormant row's words, stage and wake,
 * lib/railActivity activitySig), never on a run, deploy or worker heartbeat
 * that changes none of them.
 */
export function useRailDormantSplit(dormant: InboxSession[], now: number, triggersOf: (row: InboxSession) => TriggerRow[]) {
  const splitSig = useInboxStore((st) => dormantSplitSig(st, dormant, now, triggersOf));
  const split = useMemo(() => {
    const st = useInboxStore.getState();
    const activity = new Map<string, RowActivity>();
    const working: InboxSession[] = [];
    const shipping: InboxSession[] = [];
    const sleeping: InboxSession[] = [];
    for (const row of dormant) {
      const a = rowActivity(st, row, now, triggersOf(row));
      activity.set(row._id, a);
      (a.state === "working" ? working : a.state === "shipping" ? shipping : sleeping).push(row);
    }
    return { activity, working, shipping, sleeping };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the split's signature is the dep
  }, [dormant, splitSig]);
  const navSig = `${split.working.map((r) => r._id).join(",")}|${split.shipping.map((r) => r._id).join(",")}`;
  useWatchEffect(() => {
    useInboxStore.getState().setDormantSplitNav(navSig === "|" ? null : {
      working: new Set(split.working.map((r) => r._id)),
      shipping: new Set(split.shipping.map((r) => r._id)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the id signature is the dep
  }, [navSig]);
  useMountEffect(() => () => useInboxStore.getState().setDormantSplitNav(null));
  return split;
}
