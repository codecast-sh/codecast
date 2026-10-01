/**
 * What a chapter's views use to follow the film. The driver in
 * HeroFlythrough writes continuous motion (transforms, opacity, typed text)
 * straight to elements registered with `fly` and `FlyText`, with no React
 * render. State a real component shows (a status, a count, a composer's
 * value) comes from `useFilmTime`, which re-renders only when the value
 * derived from film time changes.
 */

import { createContext, useContext, useSyncExternalStore, type CSSProperties } from "react";
import { frame } from "./timeline";
import { POSTER_T } from "./world";

/** Film time for one hero instance: the driver sets it every frame it renders. */
export type FilmClock = { get(): number; set(t: number): void; subscribe(fn: () => void): () => void };

export function createFilmClock(t0 = POSTER_T): FilmClock {
  let t = t0;
  const listeners = new Set<() => void>();
  return {
    get: () => t,
    set(next) {
      if (next === t) return;
      t = next;
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const posterClock = createFilmClock();
export const FilmClockContext = createContext<FilmClock>(posterClock);

/**
 * A value derived from film time. `select` must return a primitive (or a
 * stable reference): it runs every frame, and the component re-renders only
 * when its result changes. Under the seam's copy of a window (surfaces.tsx
 * SeamGhost) the clock is held at 0.
 */
export function useFilmTime<T>(select: (t: number) => T): T {
  const clock = useContext(FilmClockContext);
  const read = () => select(clock.get());
  return useSyncExternalStore(clock.subscribe, read, read);
}

/** The poster frame: initial styles and typed text, so the prerender is the poster. */
export const POSTER_FRAME = frame(POSTER_T);
const F0 = POSTER_FRAME;

/** Props that register an element with the driver, seeded with its poster-frame style so the prerender is the poster. */
export function fly(id: string, style?: CSSProperties) {
  const e = F0.els[id];
  const s: CSSProperties = { ...style };
  if (e?.transform !== undefined) s.transform = e.transform;
  if (e?.opacity !== undefined) s.opacity = e.opacity;
  if (e?.visible !== undefined) s.visibility = e.visible ? "visible" : "hidden";
  return { "data-fly": id, style: s };
}
