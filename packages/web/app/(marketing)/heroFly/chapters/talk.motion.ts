/**
 * Chapter 5, Agents talk: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "talk." (see contract.ts).
 *
 * pairA's `cast send` lifts off as the envelope and lands on pairB as a
 * "Message from" card; pairB answers the same way; then your steer on pairA
 * forks, the fork flies off it as its inbox row, and pairB opens on the fork.
 */

import { CUES } from "../fixtures/story";
import { localToWorld, PAIR } from "../world";
import type { ChapterMotion } from "./contract";

/** When each entry lands in its transcript, read by the views (mounting) and the beats below (motion). */
export const TALK_AT = {
  send: CUES.messageSent - 0.6,
  received: CUES.messageSent + 0.65,
  reply: CUES.replySent - 0.25,
  replyReceived: CUES.replySent + 0.45,
  prompt: CUES.forked - 0.55,
  forked: CUES.forked,
  /** The second window clears as the fork's row lifts toward it (so the row never crosses its text), then shows the fork. */
  forkVeil: CUES.forked + 0.12,
  forkClear: CUES.forked + 0.5,
  forkAnswer: CUES.forked + 1.3,
} as const;

/** How far below a worker window's centre its transcript's foot sits, beyond where it sat in a 340px window (the points below were measured there), and its header's middle. */
const FOOT = (PAIR.h - 340) / 2;
const HEAD = -PAIR.h / 2 + 22;

/** Inside a worker's window a full-height drop would spill past its edges: a short one, kept for the hero cards elsewhere. */
const enter = { preset: "drop", z: 60, rx: -8, y: -10 } as const;

export const motion: ChapterMotion = {
  beats: {
    pairA: [
      { id: "talk.send", cue: TALK_AT.send, ...enter },
      { id: "talk.send", cue: CUES.messageSent - 0.05, preset: "pulse", dur: 0.35, s: 0.03 },
      { id: "talk.reply", cue: TALK_AT.replyReceived, ...enter },
      { id: "talk.prompt", cue: TALK_AT.prompt, ...enter },
      { id: "talk.prompt", cue: TALK_AT.forked, preset: "pulse", dur: 0.4, s: 0.025 },
      // Its branch chips answer again as the fork's window opens: one cause, one effect.
      { id: "talk.prompt", cue: TALK_AT.forkClear + 0.25, preset: "pulse", dur: 0.45, s: 0.03 },
    ],
    pairB: [
      { id: "talk.received", cue: TALK_AT.received, ...enter },
      { id: "talk.replySend", cue: TALK_AT.reply, ...enter },
      { id: "talk.replySend", cue: CUES.replySent - 0.05, preset: "pulse", dur: 0.35, s: 0.03 },
      { id: "talk.forkHeadCover", cue: TALK_AT.forkVeil, dur: 0.35, preset: "fadeIn" },
      { id: "talk.forkCover", cue: TALK_AT.forkVeil, dur: 0.35, preset: "fadeIn" },
      { id: "talk.forkHead", cue: TALK_AT.forkClear + 0.25, dur: 0.3, preset: "fadeIn" },
      { id: "talk.forkFeed", cue: TALK_AT.forkClear + 0.25, dur: 0.3, preset: "fadeIn" },
      { id: "talk.forkAnswer", cue: TALK_AT.forkAnswer, ...enter },
    ],
  },
  flyers: [
    { id: "talk.envelope", cue: CUES.messageSent, dur: 0.7, from: localToWorld("pairA", -60, 40 + FOOT, 4), to: localToWorld("pairB", -80, FOOT, 4), arc: 220, rot: [[0, -8, 0], [0, -8, 8], [0, -8, 0]], ease: "glide", fade: [0.1, 0.12] },
    // The fork lifts off your steer at the foot of the worker's pane and lands on the second window's header, turned as each window is, so it never cuts into either.
    { id: "talk.fork", cue: CUES.forked + 0.1, dur: 0.85, from: localToWorld("pairA", 40, 120 + FOOT, 8), to: localToWorld("pairB", -40, HEAD, 8), arc: 200, rot: [[0, -5, 0], [0, -9, 4], [0, -3, 0]], scale: [0.9, 1], swell: 0.06, ease: "glide", fade: [0.12, 0.2] },
    { id: "talk.envelopeBack", cue: CUES.replySent - 0.2, dur: 0.7, from: localToWorld("pairB", -40, 70 + FOOT, 4), to: localToWorld("pairA", -60, 92 + FOOT, 4), arc: 140, rot: [[0, -8, 0], [0, -8, -8], [0, -8, 0]], ease: "glide", fade: [0.1, 0.14] },
  ],
};
