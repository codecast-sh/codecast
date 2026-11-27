// A theme frame's title band and hover tools (pl-1145): the live chip of the
// object it is about, a "new" mark for objects this board's call made, and
// the Reflow and Collapse controls. What a frame may do arrives through
// BoardFrameContext (lib/boards/frameContext).
import { useContext } from "react";
import { ChevronsDownUp, LayoutDashboard } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { frameRef } from "@codecast/shared/artifacts/board";
import { EntityIdPill } from "../EntityIdPill";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useEntityResolution } from "../../lib/entityDisplay";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { BoardFrameContext } from "../../lib/boards/frameContext";
import type { BoardEl } from "./boardTypes";

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

/** What a frame's title reads: the object's chip, or the title. A frame shows where it stands by being folded with a deliverable, not by a tag. */
export function FrameTitle({ el, title }: { el: BoardEl; title: string }) {
  const ref = frameRef(el);
  return ref ? <FrameChip refId={ref} title={title} /> : <>{title || "Frame"}</>;
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
