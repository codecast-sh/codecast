// A theme frame's title band and hover tools (pl-1145): the live chip of the
// object it is about, its discussion status, a "new" mark for objects this
// board's call made, and the Reflow and Collapse controls. The board passes
// what a frame may do through BoardFrameContext, so each memoized FrameView
// re-renders only when its own row changes.
import { createContext, useContext } from "react";
import { ChevronsDownUp, LayoutDashboard } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { frameRef, frameStatus } from "@codecast/shared/artifacts/board";
import { EntityIdPill } from "../EntityIdPill";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useEntityResolution } from "../../lib/entityDisplay";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import type { BoardEl } from "./boardTypes";

export type BoardFrameActions = {
  /** The board's doc id: a chip's object made in the call whose board this is reads "new". */
  docId: string | null;
  readOnly: boolean;
  reflow(key: string): void;
  /** Collapse an open frame, expand a folded one. */
  toggleFold(key: string): void;
  /** The board's element by key, folded away or not: the pill counts what it holds. */
  get(key: string): BoardEl | undefined;
};

export const BoardFrameContext = createContext<BoardFrameActions>({
  docId: null,
  readOnly: true,
  reflow: () => {},
  toggleFold: () => {},
  get: () => undefined,
});

/** The object's chip, or the frame's own title when the object can't be read. */
function FrameChip({ refId, title }: { refId: string; title: string }) {
  const { docId } = useContext(BoardFrameContext);
  const r = useEntityResolution(refId);
  const fromCall = r.entity?.from_call ? String(r.entity.from_call) : null;
  const { data: call } = useQueryNoThrow(api.transcripts.webGetCallRef, fromCall && docId ? { ref: fromCall } : "skip");
  if (r.served && !r.entity) return <>{title || refId}</>;
  const isNew = !!docId && (call as { board?: string | null } | null | undefined)?.board === docId;
  return (
    <>
      {/* Board UI: the press reaches the link and its hover card instead of starting a drag. */}
      <span data-board-ui className="board-frame-chip"><EntityIdPill shortId={refId} fallback={title || refId} /></span>
      {isNew && <span className="board-frame-new">new</span>}
    </>
  );
}

/** What a frame's title reads: status tag, then the object's chip (or the title). */
export function FrameTitle({ el, title }: { el: BoardEl; title: string }) {
  const ref = frameRef(el);
  const status = frameStatus(el);
  return (
    <>
      {status && <span className={`board-frame-status is-${status}`}>{status}</span>}
      {ref ? <FrameChip refId={ref} title={title} /> : title || "Frame"}
    </>
  );
}

/** Reflow and Collapse, shown while the frame is hovered. */
export function FrameTools({ el }: { el: BoardEl }) {
  const a = useContext(BoardFrameContext);
  if (a.readOnly) return null;
  return (
    <div className="board-frame-tools" data-board-ui>
      <ShortcutTooltip label="Reflow: lay out what's inside" side="top">
        <button type="button" className="board-bar-btn" aria-label="Reflow frame" onClick={() => a.reflow(el.key)}><LayoutDashboard size={14} strokeWidth={1.75} /></button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Collapse" side="top">
        <button type="button" className="board-bar-btn" aria-label="Collapse frame" onClick={() => a.toggleFold(el.key)}><ChevronsDownUp size={14} strokeWidth={1.75} /></button>
      </ShortcutTooltip>
    </div>
  );
}
