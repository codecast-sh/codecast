"use client";

import React, { memo, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { threadStateAskParts, type ThreadStateRow } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { withoutUndo } from "../store/undoStack";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { PrStatusChip } from "./PrStatusChip";
import { TextWithMentions } from "./EntityIdPill";
import { threadStateView, THREAD_STATE_STATUS_META, type ThreadStateView } from "../lib/threadState";
import { copyText } from "../lib/copyText";

import { useWatchEffect } from "../hooks/useWatchEffect";
// The pinned thread state, rendered directly above the composer: the agent's own
// standing answer to "where does this thread stand?", so a human opening a long
// or multi-party session sees the situation before reading any of it.
//
// The header is the answer: the status chip and the headline, on one line
// whether the panel is open or folded. Below it each later line is a row in an
// aligned grid, styled by its label: `You` is the ask, `Done` a quiet
// checklist, `Next` what happens next.
//
// Age stays honest without crying wolf. The header always says how old the
// state is; once the thread has run well past it, it also counts the messages
// since and turns yellow. Past that the view is null and the panel disappears
// (lib/threadState decides the cutoff).

const TONE: Record<ThreadStateView["freshness"], { bar: string; label: string; meta: string }> = {
  fresh: { bar: "border-l-sol-cyan/70", label: "text-sol-cyan/80", meta: "text-sol-text-dim" },
  aging: { bar: "border-l-sol-yellow/70", label: "text-sol-yellow/90", meta: "text-sol-yellow/70" },
};

export const ThreadStatePanel = memo(function ThreadStatePanel({
  conversationId,
  threadState,
  threadStateAt,
  threadStateMsgCount,
  threadStateStatus,
  messageCount,
  canClear = true,
}: {
  conversationId: string;
  threadState?: string | null;
  threadStateAt?: number | null;
  threadStateMsgCount?: number | null;
  threadStateStatus?: string | null;
  messageCount?: number | null;
  canClear?: boolean;
}) {
  // The age and the stale cutoff are time-driven, not field-driven — without a
  // coarse ticker the panel would keep claiming "just now" for hours.
  const now = useCoarseNow(30_000);
  const collapsed = useInboxStore((s) => s.clientState?.ui?.thread_state_collapsed === true);
  // The pull request this session shepherds. It sits in the same seam above the
  // composer because it answers the same question the pinned state does: what
  // is this session waiting on. The field only changes when the shepherd
  // rewrites it, so subscribing to it directly does not follow row churn.
  const prStatus = useInboxStore((s) => s.sessions[conversationId]?.pr_status ?? null);

  const toggle = () =>
    useInboxStore.getState().updateClientUI({ thread_state_collapsed: !collapsed });

  const clear = (headline: string) => {
    // Nulls, not undefined: the patch rail reads null as an explicit clear and
    // ignores undefined, so an Undo on a legacy row (written before the counts
    // existed) still restores exactly what was there.
    const previous = {
      thread_state: threadState ?? null,
      thread_state_at: threadStateAt ?? null,
      thread_state_msg_count: threadStateMsgCount ?? null,
      thread_state_status: threadStateStatus ?? null,
    };
    // Stays on its own toast (its description names the cleared headline), so
    // it stays off the window's undo history: two undos of one clear would diverge.
    withoutUndo(() => useInboxStore.getState().patchConversation(conversationId, {
      thread_state: null,
      thread_state_at: null,
      thread_state_msg_count: null,
      thread_state_status: null,
    }));
    toast("Pinned state cleared", {
      description: headline,
      action: {
        label: "Undo",
        onClick: () => withoutUndo(() => useInboxStore.getState().patchConversation(conversationId, previous)),
      },
    });
  };

  return (
    <ThreadStatePanelView
      conversationId={conversationId}
      threadState={threadState}
      threadStateAt={threadStateAt}
      threadStateMsgCount={threadStateMsgCount}
      threadStateStatus={threadStateStatus}
      messageCount={messageCount}
      now={now}
      collapsed={collapsed}
      prStatus={prStatus}
      onToggle={toggle}
      onClear={canClear ? clear : undefined}
    />
  );
});

/** The panel drawn from props: the state, the clock, whether it is folded, and
 *  the pull request beside it. ThreadStatePanel feeds it from the store; a
 *  surface outside the app feeds it fixtures. Without `onClear` it offers no
 *  clear. */
export function ThreadStatePanelView({
  conversationId,
  threadState,
  threadStateAt,
  threadStateMsgCount,
  threadStateStatus,
  messageCount,
  now,
  collapsed,
  prStatus,
  onToggle,
  onClear,
}: {
  conversationId: string;
  threadState?: string | null;
  threadStateAt?: number | null;
  threadStateMsgCount?: number | null;
  threadStateStatus?: string | null;
  messageCount?: number | null;
  now: number;
  collapsed: boolean;
  prStatus: React.ComponentProps<typeof PrStatusChip>["status"];
  onToggle: () => void;
  onClear?: (headline: string) => void;
}) {
  // Long states expand in place instead of scrolling inside the panel: the body
  // clamps at a readable height, and when the text runs past it a "Show all"
  // control removes the clamp. `overflows` is measured only while clamped —
  // measuring the unclamped body would always read "fits" and eat the control
  // that collapses it back.
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => setExpanded(false), [conversationId]);
  useLayoutEffect(() => {
    if (expanded) return;
    const el = bodyRef.current;
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [threadState, collapsed, expanded]);

  const view = threadStateView(
    {
      thread_state: threadState,
      thread_state_at: threadStateAt,
      thread_state_msg_count: threadStateMsgCount,
      thread_state_status: threadStateStatus,
    },
    messageCount ?? 0,
    now,
  );
  if (!view) {
    if (!prStatus) return null;
    return (
      <div className="relative z-20 bg-sol-bg pt-1.5">
        <div className="mx-auto conv-col px-2 sm:px-4 pb-1.5 flex items-center">
          <PrStatusChip status={prStatus} size="panel" />
        </div>
      </div>
    );
  }

  const tone = TONE[view.freshness];
  // The declared status owns the bar when present — it is the semantic signal;
  // freshness keeps the age and takes the bar over only on rows written before
  // the status existed.
  const statusMeta = view.status ? THREAD_STATE_STATUS_META[view.status] : null;
  const barClass = statusMeta ? statusMeta.bar : tone.bar;
  const canClear = !!onClear;
  const clear = () => onClear?.(view.headline);

  return (
    // z-20 clears the composer's own sticky layer: MessageInput pulls a 64px
    // gradient fade UP over whatever sits above it (to fade scrolled messages
    // behind the input), and without this the panel's last lines wash out under
    // it. The panel is not scrolled content, so it belongs above that fade.
    <div className="relative z-20 bg-sol-bg pt-1.5">
      <div className="mx-auto conv-col px-2 sm:px-4 pb-1.5">
        <div
          className={`group rounded-xl border border-sol-border/40 border-l-2 ${barClass} bg-sol-bg-alt/60 overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-200`}
        >
          <div className="flex items-start gap-2 pl-3 pr-1.5 pt-[7px] pb-1.5">
            <button
              type="button"
              onClick={onToggle}
              title={collapsed ? "Show the full pinned state" : "Collapse the pinned state"}
              aria-expanded={!collapsed}
              className="flex flex-wrap items-start gap-x-2.5 gap-y-1 min-w-0 flex-1 text-left"
            >
              {statusMeta ? (
                <span
                  className={`mt-[3px] shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full border text-[9px] font-semibold uppercase tracking-wide ${statusMeta.chip}`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  {statusMeta.label}
                </span>
              ) : (
                <span className={`mt-[3px] shrink-0 text-[10px] uppercase tracking-wider font-semibold ${tone.label}`}>
                  Pinned
                </span>
              )}
              {/* Open on a narrow screen, the headline takes its own full line
                  under the chip and the age instead of a sliver beside them. */}
              <span
                className={`min-w-0 text-[13.5px] leading-[1.45] font-semibold text-sol-text ${collapsed ? "flex-1 truncate" : "order-last basis-full break-words sm:order-none sm:basis-0 sm:flex-1"}`}
              >
                {view.headline}
              </span>
              {view.stamp && (
                <span data-cc-tech className={`ml-auto mt-[3px] shrink-0 text-[10px] ${tone.meta}`}>{view.stamp}</span>
              )}
            </button>
            <PrStatusChip status={prStatus} size="panel" className="shrink-0" />
            <div className="flex items-center shrink-0">
              {canClear && (
                <button
                  type="button"
                  onClick={clear}
                  title="Clear the pinned state"
                  aria-label="Clear the pinned state"
                  className="p-1 rounded text-sol-text-dim hover:text-sol-red hover:bg-sol-red/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all"
                >
                  <X className="w-3 h-3" strokeWidth={2.5} />
                </button>
              )}
              <button
                type="button"
                onClick={onToggle}
                aria-label={collapsed ? "Expand" : "Collapse"}
                className="p-1 rounded text-sol-text-dim hover:text-sol-text-muted hover:bg-sol-bg-highlight transition-colors"
              >
                <ChevronDown
                  className={`w-3 h-3 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
                  strokeWidth={2.5}
                />
              </button>
            </div>
          </div>
          {!collapsed && view.rows.length > 0 && (
            <div className="px-3 pb-2.5">
              <div
                ref={bodyRef}
                className={`relative overflow-hidden transition-[max-height] duration-300 ${expanded ? "max-h-[1200px]" : "max-h-64"}`}
              >
                <StateRows rows={view.rows} />
                {overflows && !expanded && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-sol-bg-alt to-transparent" />
                )}
              </div>
              {(overflows || expanded) && (
                <button
                  type="button"
                  onClick={() => setExpanded((e) => !e)}
                  className="mt-1 flex items-center gap-1 text-[10px] font-medium text-sol-text-dim hover:text-sol-text-muted transition-colors"
                >
                  <ChevronDown
                    className={`w-3 h-3 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
                    strokeWidth={2.5}
                  />
                  {expanded ? "Show less" : "Show all"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Labels that mark the ask: `You`, and `Blocked` on notes written before it. */
const ASK_LABELS = new Set(["You", "Blocked"]);

/** A leading day and time on a `Next` item ("5:45 AM", "Fri 6:20 AM PT"). */
const LEADING_TIME = /^((?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?\d{1,2}(?::\d{2})?\s?(?:AM|PM|am|pm)(?:\s+[A-Z]{1,3}T)?)[\s:,]+(?=\S)/;

const items = (text: string) => text.split(/\s+·\s+/).map((s) => s.trim()).filter(Boolean);

/** The lines under the headline: a narrow label column and the line beside it. */
function StateRows({ rows }: { rows: ThreadStateRow[] }) {
  return (
    <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px] leading-normal break-words">
      {rows.map((row, i) => {
        const ask = !!row.label && ASK_LABELS.has(row.label);
        return (
          <React.Fragment key={i}>
            <span className={`text-[11px] ${ask ? "pt-[5px] font-semibold text-sol-yellow" : "pt-px text-sol-text-dim"}`}>
              {row.label}
            </span>
            {ask ? (
              <AskLine text={row.text} />
            ) : row.label === "Done" ? (
              <span className="min-w-0 text-sol-text-muted">
                {items(row.text).map((item, j) => (
                  <span key={j} className="mr-3.5 inline-block">
                    <Check className="mr-1 inline h-3 w-3 -translate-y-px text-sol-green" strokeWidth={2.5} />
                    <RowText text={item} />
                  </span>
                ))}
              </span>
            ) : row.label === "Next" ? (
              <span className="min-w-0 text-sol-text-muted">
                {items(row.text).map((item, j) => {
                  const at = item.match(LEADING_TIME);
                  return (
                    <span key={j} className="block">
                      {at && <span className="mr-1.5 font-semibold text-sol-text-secondary">{at[1]}</span>}
                      <RowText text={at ? item.slice(at[0].length) : item} />
                    </span>
                  );
                })}
              </span>
            ) : (
              <span className="min-w-0 text-sol-text-muted">
                <RowText text={row.text} />
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** The ask, at full contrast on an amber wash. A command that ends it gets a
 *  line of its own and a copy button. */
function AskLine({ text }: { text: string }) {
  const { prose, command } = threadStateAskParts(text);
  return (
    <div className="min-w-0 -ml-2 rounded-md border border-sol-yellow/20 bg-sol-yellow/[0.08] px-2 py-1 text-sol-text">
      {prose && <RowText text={prose} />}
      {command && (
        <div className={`flex min-w-0 overflow-hidden rounded border border-sol-border/40 bg-sol-bg/70 ${prose ? "mt-1" : ""}`}>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all px-2 py-0.5 text-[11px] leading-relaxed text-sol-text-secondary">
            {command}
          </code>
          <button
            type="button"
            onClick={() => void copyText(command, "Command copied")}
            className="flex shrink-0 items-center gap-1 border-l border-sol-border/40 px-2 text-[10.5px] font-semibold text-sol-yellow hover:bg-sol-yellow/10 transition-colors"
          >
            <Copy className="h-3 w-3" strokeWidth={2.2} />
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

/** A row's text with its `code` spans set as code and its object ids drawn as
 *  live pills. */
function RowText({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded border border-sol-border/40 bg-sol-bg/60 px-1 text-[11.5px] text-sol-text-secondary">
            {part}
          </code>
        ) : (
          part && <TextWithMentions key={i} text={part} bareIds />
        ),
      )}
    </>
  );
}
