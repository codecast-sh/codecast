"use client";
// The ONE window-control cluster every stage pane shows: expand (take the
// whole stage), then close — same icons, same order, same corner, whether the
// pane draws its own strip (PaneStrip) or hosts the buttons in a header it
// already has (the conversation header). Standardizing here is what keeps a
// split from reading as N different widgets glued together.

import { Maximize2, X } from "lucide-react";

export function PaneControls({
  onExpand,
  onClose,
  expandTitle = "Take the whole stage",
  closeTitle = "Close pane",
}: {
  onExpand?: () => void;
  onClose?: () => void;
  expandTitle?: string;
  closeTitle?: string;
}) {
  if (!onExpand && !onClose) return null;
  return (
    <>
      {onExpand && (
        <button onClick={onExpand} className="cc-panel__btn flex-shrink-0" title={expandTitle}>
          <Maximize2 className="w-3 h-3" />
        </button>
      )}
      {onClose && (
        <button onClick={onClose} className="cc-panel__btn is-close flex-shrink-0" title={closeTitle}>
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </>
  );
}
