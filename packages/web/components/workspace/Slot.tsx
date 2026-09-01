"use client";
import { X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import type { SlotId } from "../../store/workspace";

// The standard close affordance for a workspace-slot region, dropped into a
// header the region already draws (the session rail, the comment rail, the
// doc detail). A lesson kept from an earlier pass: chrome you embed and
// chrome that frames a panel are different components — a full header bar
// crammed into an existing header nested one header inside another. Stage
// PANES have their own richer cluster (components/stage/PaneControls); this
// stays the slot-shaped close.

/** The buttons only — for a region that already draws its own header row. */
export function SlotActions({
  slot,
  onClose,
}: {
  slot: SlotId;
  onClose?: () => void;
}) {
  const close = () => {
    if (onClose) return onClose();
    // remember:true — a close BY HAND is sticky; automatic rules must not
    // immediately put the same pane back (see hidePane).
    useInboxStore.getState().wsHide(slot, { remember: true });
  };
  return (
    <span className="cc-panel__actions">
      <button onClick={close} className="cc-panel__btn is-close" title="Close">
        <X className="w-3.5 h-3.5" />
      </button>
    </span>
  );
}
