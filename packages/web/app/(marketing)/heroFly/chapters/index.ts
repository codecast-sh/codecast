/**
 * The film's chapters. The poster frame's chapters are in the first paint
 * (and the prerender); every other chapter is its own chunk, loaded once the
 * page is idle, well before the camera heads its way.
 */

import { useState } from "react";
import { useMountEffect } from "@/hooks/useMountEffect";
import type { ChapterId } from "../world";
import type { HeroChapter } from "./contract";
import { chapter as conversation } from "./conversation.chapter";
import { chapter as inbox } from "./inbox.chapter";

export const EAGER_CHAPTERS: HeroChapter[] = [inbox, conversation];

type Loader = () => Promise<{ chapter: HeroChapter }>;

export const LAZY_CHAPTERS: Record<Exclude<ChapterId, "inbox" | "conversation">, Loader> = {
  fanout: () => import("./fanout.chapter"),
  phone: () => import("./phone.chapter"),
  talk: () => import("./talk.chapter"),
  decide: () => import("./decide.chapter"),
  work: () => import("./work.chapter"),
  automation: () => import("./automation.chapter"),
  team: () => import("./team.chapter"),
  integrations: () => import("./integrations.chapter"),
  publish: () => import("./publish.chapter"),
  memory: () => import("./memory.chapter"),
  remote: () => import("./remote.chapter"),
};

/** Every chapter, awaited: what the guard test mounts. */
export async function loadAllChapters(): Promise<HeroChapter[]> {
  const rest = await Promise.all(Object.values(LAZY_CHAPTERS).map((load) => load().then((m) => m.chapter)));
  return [...EAGER_CHAPTERS, ...rest];
}

/** The chapters mounted so far: the eager ones, then all of them once the page is idle. */
export function useHeroChapters(): HeroChapter[] {
  const [chapters, setChapters] = useState(EAGER_CHAPTERS);
  useMountEffect(() => {
    let live = true;
    const load = () => loadAllChapters().then((all) => live && setChapters(all), () => {});
    const idle = window.requestIdleCallback?.(load, { timeout: 1500 }) ?? window.setTimeout(load, 300);
    return () => {
      live = false;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  });
  return chapters;
}
