"use client";

import { memo } from "react";
import { ArrowDown, ArrowUp, Combine } from "lucide-react";
import { jointAuthors } from "@codecast/shared/contracts/jointMessage";
import { useInboxStore } from "../../store/inboxStore";
import { canSteer, partsOf, queueRowsOf, type QueueRow } from "../../lib/sharedQueue";
import { PresenceAvatar } from "../PresenceFacepile";

// Every message waiting to go into the session, from every person, in the
// order the session will take them, each with its author's face. Shown when
// the line is worth seeing: two or more waiting, or one from someone else
// (an instruction you have not read that the agent is about to act on).
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
  if (rows.length < 2 && !othersQueued) return null;

  const move = (row: QueueRow, beforeId: string | null) => st.reorderQueued(conversationId, row.message_id, beforeId);
  const merge = (row: QueueRow, into: QueueRow) => st.mergeQueued(conversationId, row.message_id, into.message_id);

  return (
    <div data-sv-shared-queue className="mx-auto conv-col px-2 sm:px-4">
      <div className="mb-1 rounded-xl border border-sol-border/40 bg-sol-bg-alt/40 overflow-hidden">
        <div className="flex items-center gap-2 px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-sol-text-dim">
          <span>Up next</span>
          <span className="tabular-nums">{rows.length}</span>
        </div>
        <ol>
          {rows.map((row, i) => {
            const parts = partsOf(row);
            const who = jointAuthors(parts);
            const steerable = canSteerQueue && canSteer(row);
            const prev = rows[i - 1];
            const next = rows[i + 1];
            return (
              <li key={row.message_id} data-sv-queue-row={row.message_id} className="group flex items-center gap-2 px-3 py-1 text-xs border-t border-sol-border/20 first:border-t-0">
                <span className="w-4 text-right tabular-nums text-sol-text-dim shrink-0">{i + 1}</span>
                <PresenceAvatar person={{ user_id: row.from_user_id ?? row.message_id, user_name: row.from_name ?? "Someone", user_color: "var(--sol-blue)", user_image: row.from_image }} size={18} ring={false} title={who} />
                <span className="shrink-0 font-medium text-sol-text">{who}</span>
                <span className="truncate min-w-0 text-sol-text-muted" title={parts.map((p) => `${p.from}: ${p.body}`).join("\n\n")}>
                  {parts.map((p) => p.body).join("  ·  ")}
                </span>
                {!canSteer(row) && <span className="ml-auto shrink-0 text-[10px] text-sol-cyan">going in now</span>}
                {steerable && (
                  <span className="ml-auto shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <QueueButton label="Move up" disabled={!prev || !canSteer(prev)} onClick={() => prev && move(row, prev.message_id)}><ArrowUp className="w-3 h-3" /></QueueButton>
                    <QueueButton label="Move down" disabled={!next} onClick={() => next && move(row, rows[i + 2]?.message_id ?? null)}><ArrowDown className="w-3 h-3" /></QueueButton>
                    <QueueButton label="Merge with the next one into one turn" disabled={!next || !canSteer(next)} onClick={() => next && merge(next, row)}>
                      <Combine className="w-3 h-3" /><span className="ml-1">Merge</span>
                    </QueueButton>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
});

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
