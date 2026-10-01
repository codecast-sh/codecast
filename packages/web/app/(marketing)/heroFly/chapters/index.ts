/**
 * The film's chapters. The poster frame's chapters are in the first paint
 * (and the prerender); every other chapter is its own chunk, loaded once the
 * page is idle, well before the camera heads its way.
 */

import { startTransition, useState } from "react";
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

const FILM_ORDER = Object.keys(LAZY_CHAPTERS) as (keyof typeof LAZY_CHAPTERS)[];

/**
 * The chapters mounted so far: the eager ones, then the rest once the page is
 * idle. Each chapter joins in its own idle callback and transition, in film
 * order, so no one commit holds a frame of the opening. A chunk that fails is
 * tried once more after a pause; the film plays on without it until then.
 */
export function useHeroChapters(): HeroChapter[] {
  const [chapters, setChapters] = useState(EAGER_CHAPTERS);
  useMountEffect(() => {
    let live = true;
    const loaded = new Map<string, HeroChapter>();
    const mounted: HeroChapter[] = [...EAGER_CHAPTERS];
    const idles: number[] = [];
    const timers: number[] = [];
    let queued = false;
    const whenIdle = (fn: () => void, timeout: number) => {
      if (window.requestIdleCallback) idles.push(window.requestIdleCallback(fn, { timeout }));
      else timers.push(window.setTimeout(fn, 300));
    };
    const pending = () => FILM_ORDER.filter((id) => loaded.has(id) && !mounted.some((c) => c.id === id));
    // One chapter per idle callback, in film order.
    const flush = () => {
      queued = false;
      const [next] = pending();
      if (!live || !next) return;
      mounted.push(loaded.get(next)!);
      const snapshot = [...mounted];
      startTransition(() => setChapters(snapshot));
      if (pending().length) schedule();
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      whenIdle(flush, 500);
    };
    const load = (ids: (keyof typeof LAZY_CHAPTERS)[], retry: boolean) =>
      Promise.allSettled(ids.map((id) => LAZY_CHAPTERS[id]().then((m) => loaded.set(id, m.chapter)))).then((res) => {
        if (!live) return;
        schedule();
        const failed = ids.filter((_, i) => res[i].status === "rejected");
        if (!failed.length) return;
        if (retry) timers.push(window.setTimeout(() => live && load(failed, false), 2000));
        else console.warn(`hero: chapters failed to load: ${failed.join(", ")}`);
      });
    whenIdle(() => load(FILM_ORDER, true), 1500);
    return () => {
      live = false;
      idles.forEach((id) => window.cancelIdleCallback?.(id));
      timers.forEach((id) => window.clearTimeout(id));
    };
  });
  return chapters;
}
