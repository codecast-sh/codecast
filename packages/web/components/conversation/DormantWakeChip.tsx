// The conversation header's answer to "why is this parked": for a session the
// inbox files under Dormant, the same wake its card's child line names
// (DormantWakeRow), beside the status pill.
import { useTrackedStore, useInboxStore, railRowPlacement, waitsOnViewer, type InboxSession } from "../../store/inboxStore";
import { rowSigExcluding } from "../../store/wakeSig";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useTriggers } from "../../hooks/useSyncTriggers";
import type { TaskRow } from "../triggerTasks";
import { SchedChildArrow } from "../TriggerRow";
import { useDormantWake, useSessionTriggerRows } from "../../hooks/useDormantWake";
import { DORMANT_CLAIM_TITLE } from "../inbox/dormantWake";
import { WakeWhen } from "../inbox/DormantWakeRows";

const LIVENESS_FIELDS = new Set(["updated_at", "last_heartbeat", "last_metrics_at", "last_active_at", "last_message_at"]);

export function DormantWakeChip({ conversationId }: { conversationId: string | undefined }) {
  const s = useTrackedStore([
    (st) => (conversationId ? rowSigExcluding(st.sessions[conversationId], LIVENESS_FIELDS) : null),
    (st) => st.currentUser?._id,
  ]);
  const now = useCoarseNow(30_000);
  const session = conversationId ? s.sessions[conversationId] : undefined;
  if (!session) return null;
  const bucket = railRowPlacement(session, now).bucket;
  const meId = s.currentUser?._id?.toString?.() ?? null;
  const dormant = bucket === "dormant" || (bucket === "needs_input" && !waitsOnViewer(session, meId));
  return dormant ? <DormantWakeChipBody session={session} /> : null;
}

function DormantWakeChipBody({ session }: { session: InboxSession }) {
  const { tasks, ready } = useTriggers();
  const rows = useSessionTriggerRows(session, (ready || tasks.length > 0 ? tasks : undefined) as TaskRow[] | undefined);
  const { wake, label: { what, when, warn } } = useDormantWake(session, rows);
  const tone = warn ? "text-sol-yellow/90" : "text-sol-text-dim";
  const openTrigger = wake.kind === "trigger"
    ? () => useInboxStore.getState().setTriggerStripRequest({ convId: session._id, taskId: wake.row.task._id, expand: true, nonce: Date.now() })
    : undefined;
  const body = (
    <>
      <SchedChildArrow label="What wakes this session" className="text-sol-text-dim/70" />
      <span className={`truncate min-w-0 ${tone}`}>{what}</span>
      <span className={`shrink-0 whitespace-nowrap tabular-nums ${tone}`}>
        {typeof when === "string" ? "· " : null}<WakeWhen when={when} />
      </span>
    </>
  );
  const className = "inline-flex items-center gap-1 min-w-0 max-w-[26rem] text-meta";
  const title = warn ? DORMANT_CLAIM_TITLE : what;
  return openTrigger ? (
    <button type="button" data-dormant-wake={wake.kind} onClick={openTrigger} title={title} className={`${className} rounded px-1 hover:bg-sol-blue/[0.08] transition-colors`}>
      {body}
    </button>
  ) : (
    <span data-dormant-wake={wake.kind} title={title} className={className}>
      {body}
    </span>
  );
}
