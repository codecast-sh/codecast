"use client";

import { memo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Combine, MessagesSquare, X, Zap } from "lucide-react";
import { jointAuthors } from "@codecast/shared/contracts/jointMessage";
import { useInboxStore } from "../../store/inboxStore";
import { canSteer, isHeldForTurnEnd, partsOf, queueGroupsOf, queueLineOf, queueRowsOf, QUEUE_PREVIEW_LINES, type QueueLine, type QueueRow } from "../../lib/sharedQueue";
import { formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { useRunnerSilence } from "../../hooks/useRunnerSilence";
import { PresenceAvatar } from "../PresenceFacepile";
import { EntityIdPill } from "../EntityIdPill";

// Every message waiting to go into the session, from every person, in the
// order the session will take them, each with its author's face. Shown when
// the line is worth seeing: anything queued for the end of the turn (⌘↵),
// two or more waiting, or one from someone else (an instruction you have not
// read that the agent is about to act on).
// A row reads as what it is (lib/sharedQueue queueLineOf): a person's words
// under their face, a trigger's run under its title with the session it
// fired for, another session's message under that session. A trigger that
// fired many times back to back is one line with a count, and a long queue
// shows its head with the rest behind one control, so a session that was
// away does not push its conversation off the screen.
// Anyone who may send into the session can move a message or fold two into
// one turn whose parts name each author. Reads the one home of these rows,
// the conversation's pending status row; never copies it.

function queueSig(status: any): string {
  return queueRowsOf(status).map((r) => `${r.message_id}:${r.status}:${r.queue_at ?? ""}:${r.content.length}`).join("|");
}

export const SharedQueue = memo(function SharedQueue({ conversationId, canSteerQueue }: { conversationId: string; canSteerQueue: boolean }) {
  // Wake only when the line itself changes, not on every status tick.
  useInboxStore((s) => queueSig((s.pendingMessageStatus as any)[conversationId]));
  const st = useInboxStore.getState();
  const rows = queueRowsOf((st.pendingMessageStatus as any)[conversationId]);
  const me = st.currentUser?._id ? String(st.currentUser._id) : null;
  const othersQueued = rows.some((r) => r.from_user_id && r.from_user_id !== me);
  const held = rows.filter(isHeldForTurnEnd);
  const shown = rows.length >= 2 || othersQueued || held.length > 0;
  // A queue behind a machine that stopped beating says so in its header: the
  // rows are not about to go in, they wait for that machine.
  const runnerSilence = useRunnerSilence(conversationId, shown);
  // Folded runs the reader opened, by their first row, and whether the whole
  // queue is open. Both are this reader's view of it, not shared state.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  if (!shown) return null;

  const groups = queueGroupsOf(rows);
  const visible = showAll ? groups : groups.slice(0, QUEUE_PREVIEW_LINES);
  const hiddenRows = groups.slice(visible.length).reduce((n, g) => n + g.rows.length, 0);
  const mayRemove = (row: QueueRow) => row.from_user_id === me || st.conversations[conversationId]?.user_id === me;
  const remove = (row: QueueRow) => st.cancelPendingMessage(conversationId, { messageId: row.message_id });
  const move = (row: QueueRow, beforeId: string | null) => st.reorderQueued(conversationId, row.message_id, beforeId);
  const merge = (row: QueueRow, into: QueueRow) => st.mergeQueued(conversationId, row.message_id, into.message_id);
  // Interrupt and send: the row goes to the front of what still waits, then
  // Escape stops the turn. The daemon takes the head of the line next, and a
  // stopped turn releases rows held for its end (managedSessions).
  const firstWaiting = rows.find(canSteer);
  const sendNow = (row: QueueRow) => {
    if (firstWaiting && firstWaiting !== row) move(row, firstWaiting.message_id);
    st.sendEscape(conversationId);
  };
  const toggle = (id: string) => setOpened((prev) => { const next = new Set(prev); if (!next.delete(id)) next.add(id); return next; });

  const rowItem = (row: QueueRow, line: QueueLine, nested: boolean) => {
    const i = rows.indexOf(row);
    const prev = rows[i - 1];
    const next = rows[i + 1];
    const steerable = canSteerQueue && canSteer(row);
    return (
      <li key={row.message_id} data-sv-queue-row={row.message_id} className={`group flex items-center gap-2 py-1 pr-3 text-xs border-t border-sol-border/20 first:border-t-0 ${nested ? "pl-9 bg-sol-bg-alt/30" : "pl-3"}`}>
        <span className="w-5 text-right tabular-nums text-sol-text-dim shrink-0">{i + 1}</span>
        <QueueLineBody row={row} line={line} nested={nested} />
        {!canSteer(row) && <span className="ml-auto shrink-0 text-[10px] text-sol-cyan">going in now</span>}
        {isHeldForTurnEnd(row) && !steerable && <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim">after this turn</span>}
        {steerable && (
          <span className="ml-auto shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <QueueButton label="Interrupt the agent and send this next" disabled={false} onClick={() => sendNow(row)}>
              <Zap className="w-3 h-3" /><span className="ml-1">Interrupt &amp; send</span>
            </QueueButton>
            <QueueButton label="Move up" disabled={!prev || !canSteer(prev)} onClick={() => prev && move(row, prev.message_id)}><ArrowUp className="w-3 h-3" /></QueueButton>
            <QueueButton label="Move down" disabled={!next} onClick={() => next && move(row, rows[i + 2]?.message_id ?? null)}><ArrowDown className="w-3 h-3" /></QueueButton>
            <QueueButton label="Merge with the next one into one turn" disabled={!next || !canSteer(next)} onClick={() => next && merge(next, row)}>
              <Combine className="w-3 h-3" /><span className="ml-1">Merge</span>
            </QueueButton>
            {mayRemove(row) && <QueueButton label="Take it out of the queue" disabled={false} onClick={() => remove(row)}><X className="w-3 h-3" /></QueueButton>}
          </span>
        )}
        {canSteer(row) && <QueueAge at={row.created_at} hideOnHover={steerable} />}
      </li>
    );
  };

  return (
    <div data-sv-shared-queue className="mx-auto conv-col px-2 sm:px-4">
      <div className="mb-1 rounded-xl border border-sol-border/40 bg-sol-bg-alt/40 overflow-hidden">
        <div className="flex items-center gap-2 px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-sol-text-dim">
          <span>Up next</span>
          <span className="tabular-nums">{rows.length}</span>
          {runnerSilence && <span data-sv-queue-waits className="normal-case tracking-normal text-sol-yellow">· waiting for {runnerSilence}</span>}
          {held.length > 0 && <span className="normal-case tracking-normal">· {held.length === rows.length ? "goes in when this turn ends" : `${held.length} wait for the end of this turn`}</span>}
          {held.length > 0 && canSteerQueue && (
            <button type="button" onClick={() => st.releaseQueued(conversationId)} className="ml-auto normal-case tracking-normal text-[10px] text-sol-cyan hover:underline">
              Send now
            </button>
          )}
        </div>
        <ol className={showAll ? "max-h-[45vh] overflow-y-auto" : undefined}>
          {visible.flatMap((group) => {
            const head = group.rows[0];
            if (group.rows.length === 1 || group.line.kind !== "trigger") return [rowItem(head, group.line, false)];
            const open = opened.has(head.message_id);
            const first = rows.indexOf(head) + 1;
            const removable = canSteerQueue ? group.rows.filter(mayRemove) : [];
            return [
              <li key={`run:${head.message_id}`} data-sv-queue-run={group.rows.length} className="group flex items-center gap-2 px-3 py-1 text-xs border-t border-sol-border/20 first:border-t-0">
                <span className="w-5 text-right tabular-nums text-sol-text-dim shrink-0">{first}</span>
                <button type="button" onClick={() => toggle(head.message_id)} aria-expanded={open} title={open ? "Fold these runs" : "Show each run"} className="flex min-w-0 items-center gap-2 text-left">
                  <Zap className="w-3.5 h-3.5 shrink-0 text-sol-violet/70" />
                  <span className="shrink-0 font-medium text-sol-text">{group.line.title}</span>
                  <span className="shrink-0 rounded-full bg-sol-violet/15 px-1.5 text-[10px] tabular-nums text-sol-violet">×{group.rows.length}</span>
                  {open ? <ChevronDown className="w-3 h-3 shrink-0 text-sol-text-dim" /> : <ChevronRight className="w-3 h-3 shrink-0 text-sol-text-dim" />}
                </button>
                {removable.length > 0 && (
                  <span className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <QueueButton label={`Take ${removable.length === group.rows.length ? "all" : "your"} ${removable.length} out of the queue`} disabled={false} onClick={() => removable.forEach(remove)}>
                      <X className="w-3 h-3" /><span className="ml-1">Clear {removable.length}</span>
                    </QueueButton>
                  </span>
                )}
                <QueueAge at={head.created_at} hideOnHover={removable.length > 0} />
              </li>,
              ...(open ? group.rows.map((row) => rowItem(row, queueLineOf(row), true)) : []),
            ];
          })}
        </ol>
        {groups.length > QUEUE_PREVIEW_LINES && (
          <button type="button" data-sv-queue-more onClick={() => setShowAll(!showAll)} className="flex w-full items-center gap-1 border-t border-sol-border/20 px-3 py-1 text-[11px] text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60">
            {showAll ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {showAll ? "Show fewer" : `${hiddenRows} more waiting`}
          </button>
        )}
      </div>
    </div>
  );
});

/** What one row says: a person's words under their face, or what machinery
 *  delivered under the thing that sent it (a trigger, another session). */
function QueueLineBody({ row, line, nested }: { row: QueueRow; line: QueueLine; nested: boolean }) {
  if (line.kind === "trigger") {
    return (
      <>
        {!nested && <Zap className="w-3.5 h-3.5 shrink-0 text-sol-violet/70" />}
        {!nested && <span className="shrink-0 font-medium text-sol-text">{line.title}</span>}
        {line.waiting?.short_id && <span className="shrink-0"><EntityIdPill shortId={line.waiting.short_id} compact /></span>}
        <span className="truncate min-w-0 text-sol-text-muted" title={line.text}>{line.text}</span>
      </>
    );
  }
  if (line.kind === "person" || line.kind === "brief") {
    const parts = partsOf(row);
    const who = jointAuthors(parts);
    const text = line.kind === "brief" ? line.text : parts.map((p) => p.body).join("  ·  ");
    return (
      <>
        <PresenceAvatar person={{ user_id: row.from_user_id ?? row.message_id, user_name: row.from_name ?? "Someone", user_color: "var(--sol-blue)", user_image: row.from_image }} size={18} ring={false} title={who} />
        <span className="shrink-0 font-medium text-sol-text">{who}</span>
        {line.kind === "brief" && <span className="shrink-0 rounded bg-sol-bg-alt px-1 text-[10px] text-sol-text-dim">role brief</span>}
        <span className="truncate min-w-0 text-sol-text-muted" title={line.kind === "brief" ? text : parts.map((p) => `${p.from}: ${p.body}`).join("\n\n")}>{text}</span>
      </>
    );
  }
  return (
    <>
      <MessagesSquare className="w-3.5 h-3.5 shrink-0 text-sol-cyan/70" />
      {line.ref ? <span className="shrink-0"><EntityIdPill shortId={line.ref} compact /></span> : <span className="shrink-0 font-medium text-sol-text">{line.source}</span>}
      <span className="truncate min-w-0 text-sol-text-muted" title={line.text}>{line.text}</span>
    </>
  );
}

/** How long a row has waited. It yields its place to the row's controls on hover. */
function QueueAge({ at, hideOnHover }: { at: number; hideOnHover: boolean }) {
  return <span className={`ml-auto shrink-0 text-[10px] tabular-nums text-sol-text-dim ${hideOnHover ? "group-hover:hidden group-focus-within:hidden" : ""}`} title={formatFullTimestamp(at)}>{formatRelativeTime(at)}</span>;
}

function QueueButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center h-5 px-1.5 rounded text-[10px] text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-30 disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}
