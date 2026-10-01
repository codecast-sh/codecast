/**
 * Chapter 8, Automate: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "automation." (see contract.ts).
 */

import { CUES } from "../fixtures/story";
import type { RunPhase } from "../fixtures/automation";
import type { Beat } from "../world";
import type { ChapterMotion } from "./contract";

/** Chapter-internal cues, in film seconds. Cross-chapter ones are in story.ts. */
export const AUTO_AT = {
  fires: CUES.triggerFires,
  verify: CUES.triggerFires + 0.9,
  gate: CUES.triggerFires + 1.8,
  /** The trigger's run reports back and it arms for four hours on. */
  rearmed: CUES.triggerFires + 2.6,
} as const;

/** The run's phase at film time t. */
export function phaseAt(t: number): RunPhase {
  if (t < AUTO_AT.fires) return "armed";
  if (t < AUTO_AT.verify) return "implement";
  if (t < AUTO_AT.gate) return "verify";
  if (t < AUTO_AT.rearmed) return "gate";
  return "rearmed";
}

/** The surface assembles as the camera arrives (49.5): rows in reading order, then the graph and the run, all landed before the camera does. */
const ENTER = 48.6;

const auto: Beat[] = [
  ...[0, 1].map((i): Beat => ({ id: `automation.row:${i}`, cue: ENTER + 0.04 + i * 0.05, preset: "drop", z: 140, rx: -12, y: -16 })),
  { id: "automation.graph", cue: ENTER + 0.12, preset: "drop", z: 160, rx: -14, y: -18 },
  { id: "automation.run", cue: ENTER + 0.16, preset: "drop", z: 160, rx: -14, y: -18 },
  // The fire: the row answers, then the graph and the run panel as each node starts.
  { id: "automation.row:0", cue: AUTO_AT.fires, dur: 0.45, preset: "pulse", s: 0.02 },
  { id: "automation.graph", cue: AUTO_AT.fires + 0.05, dur: 0.45, preset: "pulse", s: 0.025 },
  { id: "automation.graph", cue: AUTO_AT.verify, dur: 0.45, preset: "pulse", s: 0.02 },
  { id: "automation.graph", cue: AUTO_AT.gate, dur: 0.45, preset: "pulse", s: 0.02 },
  { id: "automation.state", cue: AUTO_AT.gate, preset: "drop", z: 120, rx: -10, y: -14 },
  { id: "automation.row:0", cue: AUTO_AT.rearmed, dur: 0.45, preset: "pulse", s: 0.015 },
];

export const motion: ChapterMotion = {
  beats: { auto },
};
