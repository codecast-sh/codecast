// What a board's theme frames may do, handed down by the board
// (components/boards/BoardFrameParts reads it), so each memoized FrameView
// re-renders only when its own row changes. Its own module so the parts file
// exports only components (a Fast Refresh boundary), as lib/calls/stagePins
// holds the stage's pin context.
import { createContext } from "react";

export type BoardFrameActions = {
  /** The board's doc id: a chip's object made in the call whose board this is reads "new". */
  docId: string | null;
  readOnly: boolean;
  reflow(key: string): void;
  /** Collapse an open frame, expand a folded one. */
  toggleFold(key: string): void;
};

export const BoardFrameContext = createContext<BoardFrameActions>({
  docId: null,
  readOnly: true,
  reflow: () => {},
  toggleFold: () => {},
});
