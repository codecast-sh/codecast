// A message the daemon stopped delivering (shared/contracts/deliveryFailed):
// what it was, whether the agent can have seen it, the whole message on open,
// and the one action that puts it back: a trigger runs again, anything else is
// sent again as a new message.
import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Zap } from "lucide-react";
import { parseScheduledTask } from "@codecast/shared/contracts";
import type { DeliveryFailedNotice } from "@codecast/shared/contracts/deliveryFailed";
import { useInboxStore } from "../../../store/inboxStore";
import { EntityIdPill } from "../../EntityIdPill";
import { formatFullTimestamp, formatRelativeTime } from "../../../lib/conversationFormat";
import { ScheduledTaskBlock } from "./triggerRunBlock";
import { useIsModernStyle } from "../../../hooks/useVisualStyle";
import { Button } from "../../ui/button";

export function DeliveryFailedBlock({ notice, conversationId, timestamp }: { notice: DeliveryFailedNotice; conversationId?: string; timestamp?: number }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const modern = useIsModernStyle();
  const frame = parseScheduledTask(notice.message);
  const neverReached = notice.submitted === false;
  const cause = neverReached ? "never reached the agent" : notice.submitted ? "submitted, never echoed · may have run" : "never echoed · may have run";
  const what = frame ? frame.title : notice.message.trim().split("\n")[0];
  // A trigger runs again from its own row (its prompt is rebuilt for the new
  // run); any other message needs all of its text to be sent again.
  const action = frame?.task_id
    ? { label: "Run again", doneLabel: "Run queued", run: () => useInboxStore.getState().triggerAction(frame.task_id!, "runNow") }
    : notice.complete && conversationId
      ? {
          label: "Send again",
          doneLabel: "Sent",
          run: () => {
            const s = useInboxStore.getState();
            const clientId = s.addOptimisticMessage(conversationId, notice.message);
            s.sendMessage(conversationId, notice.message, undefined, clientId);
          },
        }
      : null;
  const tone = neverReached ? "text-sol-red" : "text-sol-orange";
  const body = open && (frame
    ? <ScheduledTaskBlock content={notice.message} timestamp={timestamp || Date.now()} />
    : <div className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-sol-text-secondary">{notice.message}{notice.complete ? "" : "…"}</div>);

  // Modern: one failure row (red when it never reached the agent, amber when it
  // may have run), its put-back action as a button on the row, the message under the chevron.
  if (modern) return (
    <div data-delivery-failed data-cc-row="error" data-cc-row-tone={neverReached ? "error" : "warn"}>
      <div
        data-cc-row-head
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpen((o) => !o); } }}
      >
        <AlertTriangle data-cc-row-icon aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        <span data-cc-row-verb>Not delivered</span>
        <span data-cc-row-text title={`${notice.writes} writes · ${cause}`}>{what}</span>
        {action && (
          <span data-cc-row-actions onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Button type="button" size="sm" variant="outline" disabled={done} onClick={() => { action.run(); setDone(true); }}>{done ? action.doneLabel : action.label}</Button>
          </span>
        )}
        <span data-cc-row-meta title={timestamp ? formatFullTimestamp(timestamp) : undefined}>{neverReached ? "never reached the agent" : "may have run"}{timestamp ? ` · ${formatRelativeTime(timestamp)}` : ""}</span>
      </div>
      {body && <div data-cc-row-detail className="px-3.5 py-2.5">{body}</div>}
    </div>
  );

  return (
    <div data-delivery-failed className={`mb-3 rounded border-l-2 ${neverReached ? "border-sol-red/50 bg-sol-red/5" : "border-sol-orange/50 bg-sol-orange/5"}`}>
      <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs">
        <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
        <span className={`shrink-0 text-mark font-medium uppercase tracking-wide ${tone}`}>Not delivered</span>
        <span className="shrink-0 text-sol-text-dim">{notice.writes} writes · {cause}</span>
        {timestamp && <span className="ml-auto shrink-0 text-meta text-sol-text-dim" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>}
      </div>
      <div className="flex min-w-0 items-center gap-2 px-3 pb-1.5 text-xs">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sol-text-muted hover:text-sol-text">
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          {frame && <Zap className="h-3 w-3 shrink-0 text-sol-violet/70" />}
          <span className="truncate">{what}</span>
        </button>
        {frame?.trigger && <EntityIdPill shortId={frame.trigger} compact />}
        {action && (
          <button
            disabled={done}
            onClick={() => { action.run(); setDone(true); }}
            className="shrink-0 rounded border border-sol-border px-2 py-0.5 text-meta text-sol-text hover:bg-sol-bg-alt disabled:cursor-default disabled:text-sol-text-dim disabled:hover:bg-transparent"
          >
            {done ? action.doneLabel : action.label}
          </button>
        )}
      </div>
      {open && (
        <div className="px-3 pb-2">
          {body}
        </div>
      )}
    </div>
  );
}
