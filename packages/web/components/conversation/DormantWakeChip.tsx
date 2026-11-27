// The conversation header's answer to "what is this doing": for a session the
// inbox files under Dormant, the same state and words its row in the rail
// carries (components/inbox/ActivityLine), beside the status pill. Working
// says what its own work is, Shipping where its change is, Sleeping what wakes
// it.
import { useTrackedStore, useInboxStore, placeInboxRows, type InboxSession } from "../../store/inboxStore";
import { rowSigExcluding } from "../../store/wakeSig";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useTriggers } from "../../hooks/useSyncTriggers";
import type { TaskRow } from "../triggerTasks";
import { useSessionTriggerRows } from "../../hooks/useDormantWake";
import { activitySig, rowActivity } from "../../lib/railActivity";
import { ActivityChip } from "../inbox/ActivityLine";

const LIVENESS_FIELDS = new Set(["updated_at", "last_heartbeat", "last_metrics_at", "last_active_at", "last_message_at"]);

export function DormantWakeChip({ conversationId }: { conversationId: string | undefined }) {
  "use no memo"; // placeInboxRows reads its module memo, the clock and the modern-view flag in localStorage; compiled, the bucket would freeze
  const s = useTrackedStore([
    (st) => (conversationId ? rowSigExcluding(st.sessions[conversationId], LIVENESS_FIELDS) : null),
    (st) => st.currentUser?._id,
  ]);
  const now = useCoarseNow(30_000);
  const session = conversationId ? s.sessions[conversationId] : undefined;
  if (!session) return null;
  // Only a row the rail draws in the sections the split makes (its Dormant
  // list: the bucket, plus a wait the viewer cannot answer), read off the
  // panel's own placement so the call lands on its memo. A row the rail draws
  // under Needs You carries no chip.
  const drawn = placeInboxRows(s, { focusedId: s.currentSessionId ?? null, now }).dormant.some((r) => r._id === session._id);
  return drawn ? <DormantWakeChipBody session={session} /> : null;
}

function DormantWakeChipBody({ session }: { session: InboxSession }) {
  "use no memo"; // rowActivity reads the store's runs, workers and rosters through getState; compiled, the words would freeze
  const { tasks, ready } = useTriggers();
  const rows = useSessionTriggerRows(session, (ready || tasks.length > 0 ? tasks : undefined) as TaskRow[] | undefined);
  const now = useCoarseNow(30_000);
  // Wake when what the chip says moves (its activity's signature), never on a
  // run, deploy or worker heartbeat that leaves it the same.
  useInboxStore((st) => activitySig(rowActivity(st, session, now, rows)));
  const activity = rowActivity(useInboxStore.getState(), session, now, rows);
  return (
    <ActivityChip
      session={session}
      activity={activity}
      now={now}
      onOpenTrigger={(row) => useInboxStore.getState().setTriggerStripRequest({ convId: session._id, taskId: row.task._id, expand: true, nonce: Date.now() })}
    />
  );
}
