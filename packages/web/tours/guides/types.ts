// Guides: the long form of a tour, for a whole feature. A guide plays one
// worked example (a small company, Tidepool) through the feature, chapter by
// chapter, on a stage drawn in the product's own pieces. It runs whether or
// not the feature is on, so it is also how a team decides to turn it on: its
// last screen is the feature's switch.
//
// A chapter is a scene and its beats. The scene draws the stage for the beat
// it is given and nothing else, so scrubbing back and forth is just a new
// beat number. A beat holds for a while and moves on by itself, unless it
// asks the person to do something on the stage (`act`): then the stage waits
// for that press, which is the moment the example becomes theirs.
import type { ComponentType } from "react";
import type { TeamFeatureKey } from "@codecast/shared/contracts";

export type GuideBeat = {
  /** What the beat says under the stage: one or two short sentences. */
  say: string;
  /** How long it holds before the next beat, in ms. */
  hold?: number;
  /** The beat waits for a press on the stage; this names it ("Accept the proposal"). */
  act?: string;
};

export type SceneProps = {
  /** The beat to draw, 0-based. Draw every earlier beat's result too. */
  beat: number;
  /** The scene's interactive control calls this when the beat asks for it. */
  act: () => void;
  /** Whether the current beat waits on `act`, so the scene can light its control. */
  waiting: boolean;
};

export type GuideChapter = {
  id: string;
  /** Two or three words, on the chapter strip and over the caption. */
  title: string;
  beats: GuideBeat[];
  Scene: ComponentType<SceneProps>;
};

export type GuideDef = {
  /** The tour id it is registered under (tours/registry.ts). */
  id: string;
  feature: TeamFeatureKey;
  /** The feature's name, as the team switch says it. */
  name: string;
  accent: string;
  /** The page the feature lives on, opened from the last screen. */
  home: string;
  /** The real page's spotlight tour, started after the guide opens the page. */
  pageTour?: string;
  chapters: GuideChapter[];
  /** The last screen: what the feature gives a team, one short line each. */
  gives: string[];
};
