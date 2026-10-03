// What every story on the page reads from the page. Its own module, so a hot
// update to a story component never mints a second context the page does not
// provide.
import { createContext, useContext } from "react";
import type { AreaColors } from "./areaColor";

/** What every story on the page needs from the page: which story has the
 *  keyboard, which wait behind a ship, how to pick one, and the area colors. */
export type StoryContext = {
  focused: string | null;
  waiting: ReadonlySet<string>;
  dimmed: ReadonlySet<string>;
  /** Give a story the focus (a click on it). */
  pick: (storyKey: string) => void;
  /** The color each area of the repository wears on this page (areaColor.assignAreaColors). */
  areaColors?: AreaColors;
};

export const StoryCtx = createContext<StoryContext>({ focused: null, waiting: new Set(), dimmed: new Set(), pick: () => {} });

export const useStoryCtx = () => useContext(StoryCtx);

/** The page's area colors, for `areaColor(area, colors)`: one resolver, one map, everywhere an area is drawn. */
export const useAreaColors = () => useContext(StoryCtx).areaColors;

/**
 * What every story element carries, on the day and in the week: its key for
 * j/k, whether it holds the page's cursor, and focus that moves the cursor,
 * so Tab and j drive one highlight. The story's own control wears
 * `data-story-trigger`, which j focuses.
 */
export function useStoryAttrs(key: string) {
  const ctx = useStoryCtx();
  return { "data-story-key": key, "data-focused": ctx.focused === key, onFocusCapture: () => ctx.pick(key) };
}
