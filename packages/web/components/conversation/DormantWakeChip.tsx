// The conversation header's answer to "why is this parked": for a session the
// inbox files under Dormant, the same wake its card's child line names
// (DormantWakeRow), beside the status pill.
import { useTrackedStore, useInboxStore, placeInboxRows, waitsOnViewer, type InboxSession } from "../../store/inboxStore";
import { rowSigExcluding } from "../../store/wakeSig";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useTriggers } from "../../hooks/useSyncTriggers";
import type { TaskRow } from "../triggerTasks";
import { SchedChildArrow } from "../TriggerRow";
import { useDormantWake, useSessionTriggerRows } from "../../hooks/useDormantWake";
import { WakeWhen } from "../inbox/DormantWakeRows";
import { teamMembersOf } from "../../lib/activeTeam";
import { memberDisplayName } from "../../lib/liveEntities";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const LIVENESS_FIELDS = new Set(["updated_at", "last_heartbeat", "last_metrics_at", "last_active_at", "last_message_at"]);

export function DormantWakeChip({ conversationId }: { conversationId: string | undefined }) {
  "use no memo"; // placeInboxRows reads its module memo, the clock and the modern-view flag in localStorage; compiled, the bucket would freeze
  const s = useTrackedStore([
    (st) => (conversationId ? rowSigExcluding(st.sessions[conversationId], LIVENESS_FIELDS) : null),
    (st) => st.currentUser?._id,
    teamMembersOf,
  ]);
  const now = useCoarseNow(30_000);
  const session = conversationId ? s.sessions[conversationId] : undefined;
  if (!session) return null;
  // The inbox's own placement (riders take their lead's bucket), read the way
  // the panel reads it so the call lands on its memo.
  const bucket = placeInboxRows(s, { focusedId: s.currentSessionId ?? null, now }).placements.get(session._id)?.bucket;
  const meId = s.currentUser?._id?.toString?.() ?? null;
  const mine = waitsOnViewer(session, meId);
  const dormant = bucket === "dormant" || (bucket === "needs_input" && !mine);
  if (!dormant) return null;
  // A teammate's session returns to its owner, never to the viewer: the words
  // name that person (or "its owner" when the roster lacks them).
  const ownerId = String(session.owner_user_id ?? session.user_id ?? "");
  const owner = mine ? null : memberDisplayName(teamMembersOf(s).find((m) => m && String(m._id) === ownerId), "its owner");
  return <DormantWakeChipBody session={session} owner={owner} />;
}

function DormantWakeChipBody({ session, owner }: { session: InboxSession; owner: string | null }) {
  const { tasks, ready } = useTriggers();
  const rows = useSessionTriggerRows(session, (ready || tasks.length > 0 ? tasks : undefined) as TaskRow[] | undefined);
  const { wake, label: { what, when, warn } } = useDormantWake(session, rows, owner);
  const tone = warn ? "text-sol-yellow/90" : "text-sol-text-dim";
  const openTrigger = wake.kind === "trigger"
    ? () => useInboxStore.getState().setTriggerStripRequest({ convId: session._id, taskId: wake.row.task._id, expand: true, nonce: Date.now() })
    : undefined;
  const body = (
    <>
      <span className="flex items-center shrink-0 -mt-[3px]"><SchedChildArrow label="What wakes this session" className="text-sol-text-dim/70" /></span>
      <span data-dormant-what className={`truncate min-w-0 flex-1 ${tone}`}>{what}</span>
      <span className={`shrink-0 whitespace-nowrap tabular-nums ${tone}`}>
        {typeof when === "string" ? <span data-dormant-sep>· </span> : null}<WakeWhen when={when} />
      </span>
    </>
  );
  const className = "flex items-center gap-1 min-w-[16rem] max-w-[28rem] shrink overflow-hidden text-meta";
  const title = warn ?? what;
  const buttonClass = `${className} rounded px-1 hover:bg-sol-blue/[0.08] transition-colors`;
  if (openTrigger) {
    return (
      <button type="button" data-dormant-wake={wake.kind} onClick={openTrigger} title={title} className={buttonClass}>
        {body}
      </button>
    );
  }
  // Every other wake opens itself whole: the line the chip truncates, when it
  // comes back and to whom, and the agent's pinned state it was read from.
  const state = session.thread_state?.trim();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-dormant-wake={wake.kind} title={title} className={buttonClass}>
          {body}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[90vw] p-3 text-meta space-y-2" data-dormant-wake-detail>
        <div className={`break-words ${tone}`}>{what}</div>
        <div className={`tabular-nums ${tone}`}><WakeWhen when={when} /></div>
        {owner ? <div className="text-sol-text-dim">{owner}'s session</div> : null}
        {state ? <pre className="whitespace-pre-wrap break-words font-mono text-sol-text max-h-64 overflow-auto">{state}</pre> : null}
      </PopoverContent>
    </Popover>
  );
}
