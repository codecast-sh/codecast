// The conversation header's answer to "what is this doing": for a session the
// inbox files under Dormant, the same state and words its row in the rail
// carries (components/inbox/ActivityLine), beside the status pill. Working
// says what its own work is, Shipping where its change is, Sleeping what wakes
// it.
import { useTrackedStore, useInboxStore, placeInboxRows, waitsOnViewer, type InboxSession } from "../../store/inboxStore";
import { rowSigExcluding } from "../../store/wakeSig";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useTriggers } from "../../hooks/useSyncTriggers";
import { sessionShipMap } from "../../hooks/useSessionShipState";
import type { TaskRow } from "../triggerTasks";
import { useSessionTriggerRows } from "../../hooks/useDormantWake";
import { activityFactsSig, rowActivity } from "../../lib/railActivity";
import { activityParts } from "../inbox/ActivityLine";
import { SessionStatusMark, SessionStatusWord } from "../inbox/SessionStatusMark";
import type { SessionStatus } from "../../lib/sessionStatus";

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
  // The inbox's own placement (riders take their lead's bucket), read the way
  // the panel reads it so the call lands on its memo.
  const bucket = placeInboxRows(s, { focusedId: s.currentSessionId ?? null, now }).placements.get(session._id)?.bucket;
  const meId = s.currentUser?._id?.toString?.() ?? null;
  const dormant = bucket === "dormant" || (bucket === "needs_input" && !waitsOnViewer(session, meId));
  return dormant ? <DormantWakeChipBody session={session} /> : null;
}

const STATUS_OF = { working: "working", shipping: "shipping", sleeping: "dormant" } as const satisfies Record<string, SessionStatus>;

function DormantWakeChipBody({ session }: { session: InboxSession }) {
  "use no memo"; // rowActivity reads the store's runs, workers and rosters through getState; compiled, the words would freeze
  const { tasks, ready } = useTriggers();
  const rows = useSessionTriggerRows(session, (ready || tasks.length > 0 ? tasks : undefined) as TaskRow[] | undefined);
  // Wake when the facts the split reads move: the workers' rows and the ship state.
  useTrackedStore([(st) => activityFactsSig(st.sessions), (st) => sessionShipMap(st as never)]);
  const now = useCoarseNow(30_000);
  const activity = rowActivity(useInboxStore.getState() as never, session, now, rows);
  const { label, warn, body, right, title, trigger } = activityParts(activity, session, now);
  const status = STATUS_OF[activity.state];
  const tone = warn ? "text-sol-yellow/90" : "text-sol-text-dim";
  const openTrigger = trigger
    ? () => useInboxStore.getState().setTriggerStripRequest({ convId: session._id, taskId: trigger.task._id, expand: true, nonce: Date.now() })
    : undefined;
  const inner = (
    <>
      <span className="flex shrink-0 items-center gap-1" aria-label={label}>
        <SessionStatusMark status={status} />
        <SessionStatusWord status={status} className="font-medium" />
      </span>
      <span data-dormant-sep aria-hidden className="shrink-0 text-sol-text-dim">·</span>
      <span data-dormant-what className={`flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap ${tone}`}>{body}</span>
      {right != null && (
        <span className={`shrink-0 whitespace-nowrap tabular-nums ${tone}`}>
          <span data-dormant-sep>· </span>{right}
        </span>
      )}
    </>
  );
  const className = "flex items-center gap-1 min-w-[16rem] max-w-[28rem] shrink overflow-hidden text-meta";
  const kind = activity.state === "sleeping" ? activity.flavor : activity.state;
  return openTrigger ? (
    <button type="button" data-dormant-wake={kind} data-activity-line={kind} onClick={openTrigger} title={title ?? undefined} className={`${className} rounded px-1 hover:bg-sol-blue/[0.08] transition-colors`}>
      {inner}
    </button>
  ) : (
    <span data-dormant-wake={kind} data-activity-line={kind} title={title ?? undefined} className={className}>
      {inner}
    </span>
  );
}
