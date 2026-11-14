// A control inside a session card (which opens on click, drags into a pane and
// has its own menu) keeps every press to itself. React carries events out of a
// portal to its parents too, so a popover opened from the card spreads it.
import type React from "react";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

// No pointerdown stop: the card does not listen for it, and Radix closes an
// open menu elsewhere on a document pointerdown, which a stop would swallow.
// Enter and Space open the card (its own key handler), so they stop here;
// every other key (Escape for a popover, Tab) goes on.
const stopActivate = (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); };

export const KEEP_OFF_CARD = { onClick: stop, onMouseDown: stop, onContextMenu: stop, onDragStart: stop, onDoubleClick: stop, onKeyDown: stopActivate };

/** For a control drawn inside the draggable card itself: a drag begins on the
 *  card whatever the child, so a press here must not start one at all. */
export const KEEP_DRAG_OFF_CARD = {
  ...KEEP_OFF_CARD,
  draggable: false,
  onMouseDown: (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); },
};
