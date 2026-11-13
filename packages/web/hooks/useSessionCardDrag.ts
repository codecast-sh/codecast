import { useCallback, useState } from "react";
import { getLabelColor } from "../lib/labelColors";
import { selectionIdsFor } from "../lib/inboxSelection";
import { SESSION_DRAG_TYPE } from "../lib/stage";
import { useFileDragTarget } from "./useFileDragTarget";

/**
 * Both drags an inbox card takes part in, as one set of props for its root.
 *
 * Dragging the card files it under a label, and the same drag is a pane: dropped
 * on the stage it splits in as this conversation (lib/stage). The native drag
 * image would be the full-width card and bury the drop targets, so it is
 * swapped for a compact pill, and the source card dims while the drag is live.
 * Files dropped ON the card go to `onDropFiles`, unfiltered.
 */
export function useSessionCardDrag({
  sessionId,
  title,
  project,
  onPaneDragStart,
  onDropFiles,
}: {
  sessionId: string;
  title: string;
  project: string;
  onPaneDragStart?: (e: React.DragEvent, title: string) => void;
  onDropFiles?: (files: File[], title: string) => void;
}) {
  const files = useFileDragTarget(useCallback((dropped: File[]) => onDropFiles?.(dropped, title), [onDropFiles, title]));
  const [isDraggingCard, setIsDraggingCard] = useState(false);

  const onDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData(SESSION_DRAG_TYPE, sessionId);
    e.dataTransfer.effectAllowed = "move";
    onPaneDragStart?.(e, title);
    const ghost = document.createElement("div");
    ghost.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-sol-bg text-sol-text border border-sol-cyan/60 shadow-xl";
    ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:9999";
    const dot = document.createElement("span");
    dot.className = `w-1.5 h-1.5 rounded-full flex-shrink-0 ${getLabelColor(project).dot}`;
    const text = document.createElement("span");
    // A ticked card carries the whole selection to every drop sink.
    const carried = selectionIdsFor(sessionId).length;
    text.textContent = carried > 1 ? `${carried} sessions` : title;
    text.style.cssText = "overflow:hidden;text-overflow:ellipsis";
    ghost.append(dot, text);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 18, 14);
    // The browser snapshots the drag image synchronously on dragstart; the
    // element only needs to survive this frame.
    requestAnimationFrame(() => ghost.remove());
    setIsDraggingCard(true);
  }, [sessionId, title, project, onPaneDragStart]);
  const onDragEnd = useCallback(() => setIsDraggingCard(false), []);

  return {
    isDragOver: files.isOver,
    isDraggingCard,
    props: { draggable: true, onDragStart, onDragEnd, ...files.handlers },
  };
}
