/**
 * Chapter 5, Agents talk: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "talk." (see contract.ts).
 *
 * pairA's `cast send` lifts off as the envelope and lands on pairB as a
 * "Message from" card; pairB answers the same way; then pairB's prompt forks.
 */

import { CUES } from "../fixtures/story";
import { localToWorld } from "../world";
import type { ChapterMotion } from "./contract";

/** When each entry lands in its transcript, read by the views (mounting) and the beats below (motion). */
export const TALK_AT = {
  send: CUES.messageSent - 0.6,
  received: CUES.messageSent + 0.65,
  reply: CUES.replySent - 0.25,
  replyReceived: CUES.replySent + 0.45,
  prompt: CUES.forked - 0.55,
  forked: CUES.forked,
} as const;

/** Inside a 540px window a full-height drop would spill past its edges: a short one, kept for the hero cards elsewhere. */
const enter = { preset: "drop", z: 60, rx: -8, y: -10 } as const;

export const motion: ChapterMotion = {
  beats: {
    pairA: [
      { id: "talk.send", cue: TALK_AT.send, ...enter },
      { id: "talk.send", cue: CUES.messageSent - 0.05, preset: "pulse", dur: 0.35, s: 0.03 },
      { id: "talk.reply", cue: TALK_AT.replyReceived, ...enter },
    ],
    pairB: [
      { id: "talk.received", cue: TALK_AT.received, ...enter },
      { id: "talk.replySend", cue: TALK_AT.reply, ...enter },
      { id: "talk.replySend", cue: CUES.replySent - 0.05, preset: "pulse", dur: 0.35, s: 0.03 },
      { id: "talk.prompt", cue: TALK_AT.prompt, ...enter },
      { id: "talk.prompt", cue: TALK_AT.forked, preset: "pulse", dur: 0.4, s: 0.025 },
    ],
  },
  flyers: [
    { id: "talk.envelope", cue: CUES.messageSent, dur: 0.7, from: localToWorld("pairA", -60, 40, 4), to: localToWorld("pairB", -80, 0, 4), arc: 220, rot: [[0, -8, 0], [0, -8, 8], [0, -8, 0]], ease: "glide", fade: [0.1, 0.12] },
    { id: "talk.envelopeBack", cue: CUES.replySent, dur: 0.5, from: localToWorld("pairB", -40, 70, 4), to: localToWorld("pairA", -60, 92, 4), arc: 140, rot: [[0, -8, 0], [0, -8, -8], [0, -8, 0]], ease: "glide", fade: [0.1, 0.14] },
  ],
};
