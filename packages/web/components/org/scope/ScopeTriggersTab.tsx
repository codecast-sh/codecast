"use client";
// The role page's Triggers tab (docs/architecture/org-staffing.md S25): every
// trigger on the role's session, its check first among them, in the same rows
// the Triggers page draws, with the same verbs. A person changes or pauses
// one here or there; pausing the role holds them all.
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { TriggerRowItem } from "../../TriggerRow";
import { ARMED_STATUSES, type TaskRow, type TriggerRow } from "../../triggerTasks";
import { useTriggers } from "../../../hooks/useSyncTriggers";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { isConvexId } from "../../../store/inboxStore";
const api = _api as any;

export function ScopeTriggersTab({ standingConversationId }: { standingConversationId: string | null }) {
  const router = useRouter();
  const { tasks: own } = useTriggers();
  // The viewer's own roster cannot carry a trigger armed under another
  // account (the seat's host); the per conversation query returns every
  // trigger anchored on the seat the viewer may see, as the header strip does.
  const { data: foreign } = useQueryNoThrow(api.agentTasks.webListForConversation, standingConversationId && isConvexId(standingConversationId) ? { conversation_id: standingConversationId } : "skip");
  const rows = useMemo<TriggerRow[]>(() => {
    if (!standingConversationId) return [];
    const seen = new Set<string>();
    const all: TaskRow[] = [];
    for (const t of [...(own as TaskRow[]), ...((foreign ?? []) as TaskRow[])]) {
      if (t.originating_conversation_id !== standingConversationId || seen.has(t._id)) continue;
      seen.add(t._id);
      all.push(t);
    }
    const armed = (t: TaskRow) => (ARMED_STATUSES.has(t.status) ? 0 : 1);
    all.sort((a, b) => armed(a) - armed(b) || (a.run_at ?? Infinity) - (b.run_at ?? Infinity));
    return all.map((task) => ({ task, openId: standingConversationId, unread: false }));
  }, [own, foreign, standingConversationId]);
  return (
    <div className="space-y-2" data-triggers-tab>
      <p className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>
        What wakes this role on its own: its check, and a trigger that fires when a session under it is waiting. Edit, pause or cancel any of them here. Pausing the role holds them all, and resuming it brings back only those, so one you paused yourself stays paused.
      </p>
      {!standingConversationId && <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>This role has not started yet. Its triggers are created when it starts.</p>}
      {standingConversationId && rows.length === 0 && <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>This role has no triggers, so nothing wakes it on its own. It still answers when someone writes to it.</p>}
      {rows.map((row) => (
        <TriggerRowItem key={row.task._id} row={row} variant="page" onOpen={(r) => router.push(`/triggers/${r.task.short_id ?? r.task._id}`)} />
      ))}
    </div>
  );
}
