"use client";
import { ReactNode } from "react";
import { Maximize2, Minimize2, Pin, PinOff, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import type { SlotId, Presentation } from "../../store/workspace";

// Panel chrome, in two pieces so it can be adopted either way:
//
//   <SlotActions>  the buttons ALONE — drop into a header a region already has
//   <SlotPanel>    the whole panel: standard header + body + presentation
//
// The distinction matters. An earlier pass dropped the full header BAR into
// headers that already existed, which nested one header inside another: a 42px
// strip crammed into the rail's button row, a stray ✕ at the screen edge
// overlapping the sidebar's hover-peek zone. Chrome you embed and chrome that
// frames a panel are different components; conflating them is what made the
// unification invisible.

function SlotButtons({
  slot,
  canPromote,
  canPin,
  onClose,
  onPromote,
}: {
  slot: SlotId;
  canPromote: boolean;
  canPin: boolean;
  onClose?: () => void;
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
  const btn = "cc-panel__btn";
  return (
    <>
      {canPin && (
        <button
          onClick={() => useInboxStore.getState().wsSetPresentation(slot, pinned ? "overlay" : "split")}
          className={`${btn} ${pinned ? "is-on" : ""}`}
          title={pinned ? "Unpin — peek over the list instead" : "Pin — keep both side by side"}
        >
          {pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
        </button>
      )}
      {canPromote && (
        <button
          onClick={() => (onPromote ? onPromote() : useInboxStore.getState().wsPromote(slot))}
          className={btn}
          title="Open full — take the stage"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      )}
      <button onClick={close} className={`${btn} is-close`} title="Close">
        <X className="w-3.5 h-3.5" />
      </button>
    </>
  );
}

/** The buttons only — for a region that already draws its own header row. */
export function SlotActions({
  slot,
  canPromote = false,
  canPin = false,
  onClose,
  onPromote,
}: {
  slot: SlotId;
  canPromote?: boolean;
  canPin?: boolean;
  onClose?: () => void;
  onPromote?: () => void;
}) {
  return (
    <span className="cc-panel__actions">
      <SlotButtons slot={slot} canPromote={canPromote} canPin={canPin} onClose={onClose} onPromote={onPromote} />
    </span>
  );
}

/**
 * A whole panel: the same header, the same body, the same edges, everywhere.
 * This is the part that makes the system visible — a rail, a peeked doc, a
 * companion conversation and the terminal all read as the same kind of object
 * because they are literally the same frame.
 */
export function SlotPanel({
  slot,
  title,
  icon,
  actions,
  canPromote = false,
  canPin = false,
  onClose,
  onPromote,
  className = "",
  children,
}: {
  slot: SlotId;
  title?: ReactNode;
  /** Small leading glyph, in the panel's muted accent. */
  icon?: ReactNode;
  /** Region-specific controls, placed before the standard ones. */
  actions?: ReactNode;
  canPromote?: boolean;
  canPin?: boolean;
  onClose?: () => void;
  onPromote?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const presentation = useInboxStore((s) => s.workspace[slot].presentation);
  return (
    <section className={`cc-panel ${presentation === "overlay" ? "cc-panel--overlay peek-overlay" : ""} ${className}`}>
      <header className="cc-panel__head">
        {icon && <span className="cc-panel__icon">{icon}</span>}
        {title != null && <span className="cc-panel__title">{title}</span>}
        <span className="cc-panel__spacer" />
        {actions}
        <SlotButtons slot={slot} canPromote={canPromote} canPin={canPin} onClose={onClose} onPromote={onPromote} />
      </header>
      <div className="cc-panel__body">{children}</div>
    </section>
  );
}
