/**
 * The chapter contract. Each chapter of the hero film is two files a builder
 * owns outright: `<id>.tsx` (its views, as parts placed into surface regions)
 * and `<id>.motion.ts` (its beats, typed text, flyers and arcs, as pure data),
 * plus its fixtures in `../fixtures/<id>.ts`. The shared world (surfaces,
 * regions, camera, scenes) and the story's cast and cues are read-only for
 * builders. See README.md in this directory.
 */

import type { ComponentType } from "react";
import type { ArcPath, Beat, ChapterId, Flyer, RegionKey, SurfaceId, TextBeat } from "../world";

/**
 * What every part and flyer component receives. `now` is the wall clock taken
 * once when the hero mounted: fixture timestamps are `now - offset`, so a
 * relative label ("2m") reads the same on every visit. Film time is not a
 * prop; read it with `useFilmTime` (../clock), which re-renders only when the
 * value you derive from it changes.
 */
export type PartProps = { now: number };

/** One view placed into one region. Parts in a region stack by `order`. */
export type ChapterPart = {
  /** Unique within the chapter; also the React key. */
  key: string;
  region: RegionKey;
  order: number;
  Component: ComponentType<PartProps>;
};

export type HeroChapter = {
  id: ChapterId;
  parts: ChapterPart[];
  /** Renderers for this chapter's flyers, keyed by the flyer id in its motion file. */
  flyers?: Record<string, ComponentType<PartProps>>;
};

/**
 * A chapter's motion. Every id is prefixed with the chapter id
 * (`inbox.row:lead`, `fanout.spawnA`) so chapters never collide on a surface;
 * the element carries `fly("<surface>/<id>")` or `flyText("<surface>/<id>")`.
 */
export type ChapterMotion = {
  beats?: Partial<Record<SurfaceId, Beat[]>>;
  texts?: Partial<Record<SurfaceId, TextBeat[]>>;
  flyers?: Flyer[];
  arcs?: ArcPath[];
};
