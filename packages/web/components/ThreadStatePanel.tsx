"use client";

import React, { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pin, ChevronDown, X } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { threadStateView, THREAD_STATE_STATUS_META, type ThreadStateView } from "../lib/threadState";
import { FormattedSummary } from "./FormattedSummary";

// The pinned thread state, rendered directly above the composer: the agent's own
// standing answer to "where does this thread stand?", so a human opening a long
// or multi-party session sees the situation before reading any of it.
//
// The panel is deliberately loud about age. A pinned line that has quietly gone
// wrong is worse than no line at all, so the header always carries how long ago
// the agent wrote it and how many messages have landed since, and the accent
// walks from cyan to yellow as that gap grows. Past that the view is null and
// the panel disappears (lib/threadState decides the cutoff).

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

  // Long states expand in place instead of scrolling inside the panel: the body
  // clamps at a readable height, and when the text runs past it a "Show all"
  // control removes the clamp. `overflows` is measured only while clamped —
  // measuring the unclamped body would always read "fits" and eat the control
  // that collapses it back.
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => setExpanded(false), [conversationId]);
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
  if (!view) return null;

  const tone = TONE[view.freshness];
  // The declared status owns the bar when present — it is the semantic signal;
  // freshness keeps the provenance text and takes the bar over only on rows
  // written before the status existed.
  const statusMeta = view.status ? THREAD_STATE_STATUS_META[view.status] : null;
  const barClass = statusMeta ? statusMeta.bar : tone.bar;
  // Everything after the headline line — rendered under it in the body.
  const lines = view.text.split("\n");
  const headlineIdx = lines.findIndex((l) => l.trim().length > 0);
  const body = lines.slice(headlineIdx + 1).join("\n").trim();
  // The "Working on" label fits a first line that names the work. A state whose
  // first line is itself a Status:/Blocked: line (the older single-line habit)
  // describes the situation, not the subject — labeling it would lie.
  const headlineIsSubject = !/^[-*•]?\s*(Status|State|Blocked):/i.test(lines[headlineIdx] ?? "");

  const toggle = () =>
    useInboxStore.getState().updateClientUI({ thread_state_collapsed: !collapsed });

  const clear = () => {
    // Nulls, not undefined: the patch rail reads null as an explicit clear and
    // ignores undefined, so an Undo on a legacy row (written before the counts
    // existed) still restores exactly what was there.
    const previous = {
      thread_state: threadState ?? null,
      thread_state_at: threadStateAt ?? null,
      thread_state_msg_count: threadStateMsgCount ?? null,
      thread_state_status: threadStateStatus ?? null,
    };
    useInboxStore.getState().patchConversation(conversationId, {
      thread_state: null,
      thread_state_at: null,
      thread_state_msg_count: null,
      thread_state_status: null,
    });
    toast("Pinned state cleared", {
      description: view.headline,
      action: {
        label: "Undo",
        onClick: () => useInboxStore.getState().patchConversation(conversationId, previous),
      },
    });
  };

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
          <div className="flex items-center gap-2 pl-2.5 pr-1.5 py-1.5">
            <button
              type="button"
              onClick={toggle}
              title={collapsed ? "Show the full pinned state" : "Collapse the pinned state"}
              className="flex items-center gap-2 min-w-0 flex-1 text-left"
            >
              {/* The pin is the whole label: it says "pinned state" on hover,
                  the status chip says which state, and the headline says what.
                  A "STATE" word next to them was a third voice for one idea. */}
              <Pin className={`w-3 h-3 shrink-0 ${tone.label}`} strokeWidth={2.2} aria-label="Pinned state" />
              {statusMeta ? (
                <span
                  className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full border text-[9px] font-semibold uppercase tracking-wide ${statusMeta.chip}`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  {statusMeta.label}
                </span>
              ) : (
                <span className={`text-[10px] uppercase tracking-wider font-semibold shrink-0 ${tone.label}`}>
                  Pinned
                </span>
              )}
              {collapsed && (
                <span className="text-[12px] text-sol-text-secondary truncate min-w-0">
                  {view.headline}
                </span>
              )}
              {view.provenance && (
                <span className={`text-[10px] shrink-0 ml-auto ${tone.meta}`}>{view.provenance}</span>
              )}
            </button>
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
                onClick={toggle}
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
          {!collapsed && (
            <div className="px-3 pb-2.5 -mt-0.5">
              <div
                ref={bodyRef}
                className={`relative text-[13px] leading-relaxed whitespace-pre-line break-words overflow-hidden transition-[max-height] duration-300 ${expanded ? "max-h-[1200px]" : "max-h-64"}`}
              >
                {/* The WHAT: first line = what this session is working on,
                    named as such so the reader never has to infer which line
                    is the subject and which is the situation. */}
                <div>
                  {headlineIsSubject && (
                    <span className="text-[9px] uppercase tracking-wider font-semibold text-sol-text-dim mr-1.5">
                      Working on
                    </span>
                  )}
                  <span className="text-sol-text font-medium">{view.headline}</span>
                </div>
                {body && (
                  <div className="text-sol-text-secondary">
                    <FormattedSummary text={body} />
                  </div>
                )}
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
});
