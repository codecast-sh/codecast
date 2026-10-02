"use client";
// The role page's Triggers tab (docs/architecture/org-staffing.md S25): every
// trigger on the role's session, its check first among them, in the same rows
// the Triggers page draws, with the same verbs. A person changes or pauses
// one here or there; pausing the role holds them all.
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { TriggerRowItem } from "../../TriggerRow";
import type { TriggerRow } from "../../triggerTasks";
import { useSeatTriggers } from "../../../hooks/useSyncTriggers";

export function ScopeTriggersTab({ standingConversationId }: { standingConversationId: string | null }) {
  const router = useRouter();
  const tasks = useSeatTriggers(standingConversationId);
  const rows = useMemo<TriggerRow[]>(() => standingConversationId ? tasks.map((task) => ({ task, openId: standingConversationId, unread: false })) : [], [tasks, standingConversationId]);
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
