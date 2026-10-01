import { startPaneDrag } from "./stage";

// The rail's shared row styling and drag (components/sidebar/navPrimitives).

const RAIL_ROW_IDLE = "text-sol-text-muted border-transparent hover:text-sol-text hover:bg-sol-bg-highlight/60";

/** A top-level rail row's tone: highlighted with an accent edge when it is the
 *  page you are on, muted otherwise. */
export function railRowTone(active: boolean, accent = "border-sol-cyan"): string {
  return active ? `bg-sol-bg-highlight text-sol-text ${accent}` : RAIL_ROW_IDLE;
}

/** A top-level rail row that is one link or button (Inbox, Threads, Feed,
 *  Questions): icon-only and centered when the rail is narrow. */
export function railRowClass(active: boolean, isNarrow: boolean, accent?: string): string {
  return `w-full flex items-center ${isNarrow ? "justify-center" : "gap-3"} px-4 py-2.5 border-l-2 transition-colors motion-reduce:transition-none text-left ${railRowTone(active, accent)}`;
}

// Anything in the rail that NAMES A PLACE is a pane waiting to happen: give
// it these props and it can be dragged onto the stage to split it in
// (lib/stage). One helper so every link and row speaks the same drag.
export function paneDragProps(path: string, title: string) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => startPaneDrag(e, { path, title }),
  };
}
