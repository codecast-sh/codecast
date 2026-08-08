"use client";
import { ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import type { SlotId, Presentation } from "../../store/workspace";

// The chrome every pane in a slot gets, from one place. Regions used to hand
// roll this: each grew its own ✕ (or forgot one), its own promote affordance,
// its own peek/pin toggle, styled slightly differently. Rendering it here is
// what makes "every column closes the same way" true by construction instead
// of a checklist.
//
// Usage during migration: a region keeps its existing markup and drops
// <SlotChrome slot="…" title="…" /> into its header row. Once a region's state
// lives in the workspace, <SlotSurface> takes over its positioning too.
export function SlotChrome({
  slot,
  title,
  canPromote = true,
  canPin = false,
  extra,
  onClose,
  onPromote,
}: {
  slot: SlotId;
  title?: ReactNode;
  /** ⤢ moves this pane onto the stage (a swap — see promote in workspace.ts). */
  canPromote?: boolean;
  /** Peek ⇄ split, for slots that support an overlay presentation. */
  canPin?: boolean;
  extra?: ReactNode;
  /** Override the default hide (e.g. a route-driven pane that closes by navigating). */
  onClose?: () => void;
  /** Override the default promote (e.g. a conversation that promotes by routing). */
  onPromote?: () => void;
}) {
  const presentation = useInboxStore((s) => s.workspace[slot].presentation);
  const pinned = presentation === "split";

  const close = () => {
    if (onClose) return onClose();
    // remember:true — a close BY HAND is sticky; automatic rules must not
    // immediately put the same pane back (see hidePane).
    useInboxStore.getState().wsHide(slot, { remember: true });
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-sol-border/20 bg-sol-bg-alt/50 flex-shrink-0">
      {title != null && (
        <span className="text-[11px] text-sol-text-muted truncate min-w-0 flex-1">{title}</span>
      )}
      {title == null && <span className="flex-1" />}
      {extra}
      {canPin && (
        <button
          onClick={() =>
            useInboxStore.getState().wsSetPresentation(slot, pinned ? "overlay" : "split")
          }
          className={`p-1 rounded-md transition-colors ${pinned ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-cyan"}`}
          title={pinned ? "Unpin — peek over the list instead" : "Pin — keep both side by side"}
        >
          {pinned ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      )}
      {canPromote && (
        <button
          onClick={() => (onPromote ? onPromote() : useInboxStore.getState().wsPromote(slot))}
          className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan transition-colors"
          title="Open full — take the stage"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        onClick={close}
        className="p-1 rounded-md text-sol-text-dim hover:text-sol-red transition-colors"
        title="Close"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// Positioning for a slot's content: a real column, or a peek sliding over its
// neighbour. The peek animation and the width rules live here rather than in
// each region, so "peek" means the same thing everywhere.
export function SlotSurface({
  presentation,
  children,
  className = "",
}: {
  presentation: Presentation;
  children: ReactNode;
  className?: string;
}) {
  if (presentation === "overlay") {
    return (
      <div
        className={`peek-overlay absolute inset-y-0 right-0 z-30 bg-sol-bg flex flex-col w-[62%] min-w-[min(480px,100%)] max-w-full border-l border-sol-border/40 ${className}`}
      >
        {children}
      </div>
    );
  }
  return <div className={`h-full flex flex-col ${className}`}>{children}</div>;
}
