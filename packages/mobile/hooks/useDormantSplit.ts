import { useMemo } from 'react';
import { useInboxStore, type InboxSession } from '@codecast/web/store/inboxStore';
import { dormantSplitSig } from '@codecast/web/lib/railActivity';
import { splitDormant } from '@/lib/inboxActivity';

/** The Dormant bucket, split for display by what each row is really doing
 *  (lib/inboxActivity, web's rail split): its own work running draws under
 *  Working, its change on the way to live under Shipping, and only a wait
 *  stays in Sleeping. Placement is untouched. The list wakes on the split's
 *  own signature (each row's words, stage and wake, web's activitySig), never
 *  on a run, deploy or heartbeat that changes none of them. The three lists
 *  come back through the inbox's chip filter. */
export function useDormantSplit(dormant: InboxSession[], now: number, chipFilter: (rows: InboxSession[]) => InboxSession[]) {
  const splitSig = useInboxStore((s) => dormantSplitSig(s, dormant, now));
  const split = useMemo(
    () => splitDormant(useInboxStore.getState(), dormant, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the split's signature is the dep
    [dormant, splitSig],
  );
  const working = useMemo(() => chipFilter(split.working), [chipFilter, split.working]);
  const shipping = useMemo(() => chipFilter(split.shipping), [chipFilter, split.shipping]);
  const sleeping = useMemo(() => chipFilter(split.sleeping), [chipFilter, split.sleeping]);
  return { activity: split.activity, working, shipping, sleeping };
}
