"use client";

import React, { memo } from "react";
import { Pin, ChevronDown, X } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { threadStateView, THREAD_STATE_STATUS_META } from "../lib/threadState";
import { FormattedSummary } from "./FormattedSummary";
import type { ThreadStateFreshness } from "@codecast/shared/contracts";

// The pinned thread state, rendered directly above the composer: the agent's own
// standing answer to "where does this thread stand?", so a human opening a long
// or multi-party session sees the situation before reading any of it.
//
// The panel is deliberately loud about age. A pinned line that has quietly gone
// wrong is worse than no line at all, so the header always carries how long ago
// the agent wrote it and how many messages have landed since, and the accent
// walks from cyan to yellow to orange as that gap grows.

const TONE: Record<ThreadStateFreshness, { bar: string; label: string; meta: string }> = {
  fresh: { bar: "border-l-sol-cyan/70", label: "text-sol-cyan/80", meta: "text-sol-text-dim" },
  aging: { bar: "border-l-sol-yellow/70", label: "text-sol-yellow/90", meta: "text-sol-yellow/70" },
  stale: { bar: "border-l-sol-orange/70", label: "text-sol-orange/90", meta: "text-sol-orange/80" },
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
  // The age and the "stale" verdict are time-driven, not field-driven — without
  // a coarse ticker the panel would keep claiming "just now" for hours.
  const now = useCoarseNow(30_000);
  const collapsed = useInboxStore((s) => s.clientState?.ui?.thread_state_collapsed === true);

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
  const headlineIdx = view.text.split("\n").findIndex((l) => l.trim().length > 0);
  const body = view.text.split("\n").slice(headlineIdx + 1).join("\n").trim();

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
              <Pin className={`w-3 h-3 shrink-0 ${tone.label}`} strokeWidth={2.2} />
              <span className={`text-[10px] uppercase tracking-wider font-semibold shrink-0 ${tone.label}`}>
                State
              </span>
              {statusMeta && (
                <span
                  className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full border text-[9px] font-semibold uppercase tracking-wide ${statusMeta.chip} ${view.freshness === "stale" ? "opacity-60" : ""}`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  {statusMeta.label}
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
              <div className="text-[13px] leading-relaxed whitespace-pre-line break-words max-h-44 overflow-y-auto">
                {/* First line = what this session is working on. It reads as the
                    panel's own headline, so it renders a step brighter than the
                    body instead of behind a "Goal:" label. */}
                <div className="text-sol-text font-medium">{view.headline}</div>
                {body && (
                  <div className="text-sol-text-secondary">
                    <FormattedSummary text={body} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
