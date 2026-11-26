// The sidebar's drag of one session card onto another row's card, which makes
// the dragged session that row's worker (lib/adoptDropStore): the card in
// flight, the row it hovers and where a drop lands. The hovered row draws
// components/inbox/AdoptHint.
import { useRef, useState, type DragEvent } from "react";
import { useEventListener } from "./useEventListener";
import { rowDropZone } from "../lib/adoptDrop";
import { adoptHintNow, adoptRefusalNow, adoptSessionNow } from "../lib/adoptDropStore";

/** The row a card hovers to adopt: the dragged title, whether it leaves the
 *  viewer's inbox, and where the row's own card sits inside the row. */
export type AdoptOver = { id: string; title: string; leaves: boolean; top: number; height: number };

/** The card in flight (dataTransfer is unreadable during dragover, and a row
 *  must know what is dragged to say whether it would take it as a worker) and
 *  the row it hovers. `onActive` hears whether any card is in flight. */
export function useAdoptDrag(onActive: (active: boolean) => void) {
  const draggedRef = useRef<string | null>(null);
  const [over, setOver] = useState<AdoptOver | null>(null);
  const end = () => {
    onActive(false);
    draggedRef.current = null;
    setOver(null);
  };
  useEventListener("dragstart", (e) => {
    if (!e.dataTransfer?.types.includes("codecast/session-id")) return;
    onActive(true);
    draggedRef.current = e.dataTransfer.getData("codecast/session-id") || null;
  });
  useEventListener("dragend", end);
  useEventListener("drop", end);
  const leave = (id: string) => setOver((cur) => (cur?.id === id ? null : cur));
  // A hover over a row's card is the row's alone: the section under it stays dark.
  const hover = (e: DragEvent, id: string, draggedId: string, top: number, height: number) => {
    e.stopPropagation();
    setOver((cur) => (cur?.id === id && cur.top === top && cur.height === height ? cur : { id, ...adoptHintNow(draggedId), top, height }));
  };
  const drop = (e: DragEvent, id: string, draggedId: string) => {
    e.preventDefault();
    e.stopPropagation();
    end();
    adoptSessionNow(draggedId, id);
  };
  return { draggedRef, over, end, leave, hover, drop };
}

/** Where a dragged card lands on a row. The adopt zone is the row's own card,
 *  measured alone: never its bars or the worker rows under it, which are
 *  other sessions. */
export function rowDropAt(e: DragEvent<HTMLDivElement>, sessionId: string, draggedId: string | null, opts: { reorderable: boolean; sectionDrop: boolean }) {
  const wrap = e.currentTarget;
  const card = wrap.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
  const adoptable = !!card && card.contains(e.target as Node) && !!draggedId && !adoptRefusalNow(draggedId, sessionId);
  const rect = (adoptable ? card! : wrap).getBoundingClientRect();
  const top = adoptable ? rect.top - wrap.getBoundingClientRect().top : 0;
  return { zone: rowDropZone(e.clientY, rect.top, rect.height, { ...opts, adoptable }), top, height: rect.height };
}
