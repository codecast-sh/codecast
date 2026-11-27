// The frame layout verbs the board's controls run (pl-1145): the hover Reflow
// and Collapse/Expand on a frame, and the toolbar's Organize. Each writes its
// whole result as one live.apply, so it is one undo step and reaches every
// other viewer as one change, as the selection bar's commands do.
import type { ArtifactOp } from "@codecast/shared/artifacts";
import { collapseFrameOps, expandFrameOps, frameCollapsed, organizeOps, reflowFrameOps } from "@codecast/shared/artifacts/board";
import type { BoardEl } from "./boardTypes";

type View = { elements: BoardEl[]; get(key: string): BoardEl | undefined };

export function boardLayoutActions(live: { apply(ops: ArtifactOp[]): unknown }, view: () => View, onError: (message: string) => void) {
  const run = (make: () => ArtifactOp[]) => {
    try {
      const ops = make();
      if (ops.length) live.apply(ops);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };
  return {
    reflow: (key: string) => run(() => reflowFrameOps(view(), key)),
    /** Collapse an open frame, expand a folded one. */
    toggleFold: (key: string) => run(() => {
      const v = view();
      return (frameCollapsed(v.get(key)) ? expandFrameOps : collapseFrameOps)(v, key);
    }),
    /** `people`: names on the board, so a frame titled with one is an agenda frame in the top row. */
    organize: (people: readonly string[]) => run(() => organizeOps(view(), { people })),
  };
}
