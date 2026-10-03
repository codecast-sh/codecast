// What every story on the page reads from the page. Its own module, so a hot
// update to a story component never mints a second context the page does not
// provide.
import { createContext, useContext } from "react";

/** What every story on the page needs from the page: which story has the
 *  keyboard, which wait behind a ship, and how to pick one. */
export type StoryContext = {
  focused: string | null;
  waiting: ReadonlySet<string>;
  dimmed: ReadonlySet<string>;
  /** Give a story the focus (a click on it). */
  pick: (storyKey: string) => void;
};

export const StoryCtx = createContext<StoryContext>({ focused: null, waiting: new Set(), dimmed: new Set(), pick: () => {} });

export const useStoryCtx = () => useContext(StoryCtx);
