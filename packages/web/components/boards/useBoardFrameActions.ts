// A board's frame layout (pl-1145) as its controls run it: the board as the
// layout functions read it, a selection widened by what folded frames hold,
// the layout verbs (each one batch: one undo step, one change for every
// viewer), Organize, and the actions the frames themselves read from context.
import { useMemo, useRef, type MutableRefObject } from "react";
import { toast } from "sonner";
import type { ArtifactPresence } from "@codecast/shared/artifacts";
import { carriedKeys, frameCollapsed } from "@codecast/shared/artifacts/board";
import type { BoardFrameActions } from "../../lib/boards/frameContext";
import type { LiveViewProps } from "../live/registry";
import { boardLayoutActions } from "./boardLayoutActions";
import type { BoardEl } from "./boardTypes";

export function useBoardFrameActions(opts: {
  live: LiveViewProps["live"];
  byKeyRef: MutableRefObject<Map<string, BoardEl>>;
  docId: string;
  readOnly: boolean;
  myName: string | undefined;
  others: ArtifactPresence[];
}) {
  const { live, byKeyRef, docId, readOnly, myName, others } = opts;
  const boardView = () => ({ elements: [...byKeyRef.current.values()], get: (k: string) => byKeyRef.current.get(k) });
  // A folded frame goes with what it holds.
  const withHeld = (keys: string[]) => {
    const pills = keys.filter((k) => frameCollapsed(byKeyRef.current.get(k)));
    return pills.length ? [...new Set([...keys, ...carriedKeys(boardView(), pills)])] : keys;
  };
  const layout = boardLayoutActions(live, boardView, (m) => toast.error(m));
  // The people on the board: a frame titled with one of their names is an agenda frame.
  const organize = () => layout.organize([myName, ...others.filter((p) => p.kind !== "agent").map((p) => p.name)].filter((n): n is string => typeof n === "string" && !!n));
  const current = useRef(layout);
  current.current = layout;
  // Stable while the board stays the same board and mode, so memoized frames do not redraw on every render.
  const frameActions = useMemo<BoardFrameActions>(() => ({
    docId,
    readOnly,
    reflow: (k) => current.current.reflow(k),
    toggleFold: (k) => current.current.toggleFold(k),
  }), [docId, readOnly]);
  return { boardView, withHeld, organize, frameActions };
}
