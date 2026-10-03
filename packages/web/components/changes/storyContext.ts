// What every story on the page reads from the page. Its own module, so a hot
// update to a story component never mints a second context the page does not
// provide.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { StoryRow } from "../../hooks/useSyncChanges";
import type { AreaColors } from "./areaColor";

/**
 * The page's story cursor, outside React state: j/k moves it, and only the two
 * stories whose `useIsFocused` answer changes re-render, never the page or the
 * rest of the stories.
 */
export type FocusStore = {
  get: () => string | null;
  set: (key: string | null) => void;
  subscribe: (fn: () => void) => () => void;
};

export function createFocusStore(initial: string | null = null): FocusStore {
  let current = initial;
  const subs = new Set<() => void>();
  return {
    get: () => current,
    set: (key) => {
      if (key === current) return;
      current = key;
      for (const fn of subs) fn();
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

/** What every story on the page needs from the page: the cursor, which stories
 *  wait behind a ship or are dimmed, how to pick one, and the area colors. */
export type StoryContext = {
  focus: FocusStore;
  waiting: ReadonlySet<string>;
  dimmed: ReadonlySet<string>;
  /** Some story matches the filters, so the dimmed ones leave the Tab order (j/k already skips them). */
  skipDimmed?: boolean;
  /** Give a story the focus (a click on it). Stable for the life of the page. */
  pick: (storyKey: string) => void;
  /** The color each area of the repository wears on this page (areaColor.assignAreaColors). */
  areaColors?: AreaColors;
  /**
   * Notes can still arrive for the day on screen: a recent day whose edition
   * is neither capped nor failed. A pending story shows its pending bar and
   * "notes pending" only while this holds; otherwise it reads as written from
   * its commit subjects, for good (editionModel.notesCanArrive).
   */
  proseLive?: boolean;
};

const idle = createFocusStore();

export const StoryCtx = createContext<StoryContext>({ focus: idle, waiting: new Set(), dimmed: new Set(), pick: idle.set });

export const useStoryCtx = () => useContext(StoryCtx);

/** The page's area colors, for `areaColor(area, colors)`: one resolver, one map, everywhere an area is drawn. */
export const useAreaColors = () => useContext(StoryCtx).areaColors;

/** Whether this story holds the page's cursor; re-renders only when that answer flips. */
export function useIsFocused(key: string): boolean {
  const { focus } = useStoryCtx();
  const snap = () => focus.get() === key;
  return useSyncExternalStore(focus.subscribe, snap, snap);
}

/**
 * What every story element carries, on the day and in the week: its key for
 * j/k, whether it holds the page's cursor, and focus that moves the cursor,
 * so Tab and j drive one highlight. The story's own control wears
 * `data-story-trigger`, which j focuses.
 */
export function useStoryAttrs(key: string) {
  const { pick } = useStoryCtx();
  const focused = useIsFocused(key);
  return { "data-story-key": key, "data-focused": focused, onFocusCapture: () => pick(key) };
}

/** The tabIndex of a story's own control: out of the Tab order while a filter dims it and others match. */
export function useTriggerTab(key: string): number | undefined {
  const { dimmed, skipDimmed } = useStoryCtx();
  return skipDimmed && dimmed.has(key) ? -1 : undefined;
}

/** The key a release and the stories it carried share. */
export const releaseKey = (r: { surface: string; sha: string }) => `${r.surface}@${r.sha}`;

export type Carried = ReadonlyMap<string, readonly StoryRow[]>;

/** The page's stories by the release that carried them (their `release`), in page order: one pass, for every stamp and tile. */
export function carriedMap(stories: readonly StoryRow[]): Carried {
  const map = new Map<string, StoryRow[]>();
  for (const s of stories) {
    if (!s.release) continue;
    const key = releaseKey(s.release);
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  return map;
}

/**
 * The carried map in a context of its own, not StoryCtx: it changes with every
 * story row, and only an open release card reads it, so no story re-renders
 * when it does.
 */
export const CarriedCtx = createContext<Carried>(new Map());

/** The stories a release carried. */
export const useCarried = (ship: { surface: string; sha: string }) => useContext(CarriedCtx).get(releaseKey(ship)) ?? [];
