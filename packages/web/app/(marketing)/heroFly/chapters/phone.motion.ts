/**
 * Chapter 4, Chat: beats, flyers and arcs, as pure data. Every id starts
 * with "phone." (see contract.ts).
 *
 * The API worker stops on a question at the foot of its pane. The question
 * flies to the phone and lands in the app's session screen, the field takes
 * focus and the keyboard rises, the answer is typed and sent (the keyboard
 * stays up, as in the app), the worker turns back to Working and streams its
 * reply above it, and the answer's arc draws back to the worker.
 *
 * The phone's screen is the app laid out at a phone's width (APP_W) and
 * scaled onto the model's screen. Each entry that lands in its feed opens its
 * own measured room (FilmGrow in ./phone.tsx), so the feed above it rises.
 */

import { CUES } from "../fixtures/story";
import { PAIR, regionPt, surfacePt } from "../world";
import type { ChapterMotion } from "./contract";

/** The app's width in CSS px (an iPhone's, a little narrower), and its scale onto the model's 276px screen. */
export const APP_W = 360;
export const APP_K = 276 / APP_W;

/** The status bar's height over the app (the band beside the notch, 24px of the model's screen). */
export const STATUS_H = Math.round(24 / APP_K);
/** The home indicator's inset under the composer, and the keyboard's height (QuickType bar, four rows, the globe row). */
export const HOME_H = 34;
export const KEYBOARD_H = 292;
/** How far the feed and composer ride up with the keyboard: its height less the home indicator's inset, which it covers, leaving the composer's own 12px foot. */
const KEYBOARD_LIFT = KEYBOARD_H - HOME_H + 12;
/** The keyboard's rise and fall (s): a little under iOS's half second, slow enough that it never covers more than a frame's worth of its height at once. */
const KEYBOARD_DUR = 0.48;

/** The question leaves the worker's pane as the camera sets off for the phone, and lands as the camera arrives. */
const FLY_CUE = 21.2;
const FLY_DUR = 1.05;

/** The phone's moments, read by the views (state) and the beats below (motion). */
export const PHONE_AT = {
  /** The feed makes room for the question while it is in flight. */
  askRoom: FLY_CUE + 0.3,
  /** The question takes over from the flyer on its last frame; the session now needs input. */
  askLands: FLY_CUE + FLY_DUR - 0.02,
  /** Alex taps the field: the caret, and the keyboard rises. */
  focus: 22.8,
  /** The answer types itself in. */
  type: 23.05,
  rate: 24,
  /** Send is pressed, and the answer leaves the field for the feed. */
  press: 24.42,
  sent: 24.52,
  /** The worker picks the answer up (the API worker's row turns green here too). */
  working: CUES.answered,
  /** The reply's turn opens and streams in, word by word. */
  reply: 25.15,
  replyWords: 25.3,
  wordRate: 11,
} as const;

/** The desk's copy of the exchange lands in the worker's pane while the camera is on the phone. */
export const DESK_AT = {
  ask: CUES.question,
  steer: PHONE_AT.sent + 0.1,
  reply: PHONE_AT.reply + 0.1,
} as const;

/** The screen's top-left on the phone surface (inside the bezel), and the question's centre on the screen at rest (app px from the screen's top-left, measured). */
const SCREEN = { x: 12, y: 12 };
const ASK_AT = { x: APP_W / 2, y: 602 };
/** A point on the screen given in app px, on the surface. */
const onScreen = (x: number, y: number, z = 0) => surfacePt("phone", SCREEN.x + x * APP_K, SCREEN.y + y * APP_K, z);

/** Where the answer's arc starts: the user's message on the screen (app px), with the feed lifted over the keyboard. */
const STEER_AT = { x: APP_W / 2, y: 452 - KEYBOARD_LIFT };

export const motion: ChapterMotion = {
  beats: {
    pairA: [{ id: "phone.ask", cue: DESK_AT.ask, preset: "drop", z: 60, rx: -10, y: 14 }],
    phone: [
      // The question is invisible while its room opens, then takes over from the flyer in place.
      { id: "phone.askBubble", cue: PHONE_AT.askLands, dur: 0.06, preset: "fadeIn" },
      // The keyboard rises with the field's focus and carries the feed and the composer up with it, at its own pace (KEYBOARD_DUR),
      // shared by the keyboard and the body riding on it so the composer stays glued to its top. Sending keeps it up, as the app
      // does: the reply streams in above it.
      { id: "phone.keyboard", cue: PHONE_AT.focus, dur: KEYBOARD_DUR, preset: "push", y: KEYBOARD_H },
      { id: "phone.body", cue: PHONE_AT.focus, dur: KEYBOARD_DUR, preset: "liftOut", y: -KEYBOARD_LIFT, z: 0 },
      { id: "phone.tap", cue: PHONE_AT.focus - 0.08, preset: "ring", dur: 0.5 },
      { id: "phone.send", cue: PHONE_AT.press, preset: "press", dur: 0.22 },
      { id: "phone.sendTap", cue: PHONE_AT.press - 0.04, preset: "ring", dur: 0.5 },
      { id: "phone.steer", cue: PHONE_AT.sent, preset: "drop", z: 40, rx: -8, y: 10 },
      { id: "phone.reply", cue: PHONE_AT.reply, dur: 0.3, preset: "fadeIn" },
    ],
  },
  flyers: [
    // From the question at the foot of the worker's pane to its place in the phone's feed, opaque to its last frame, where the feed's own copy takes over.
    { id: "phone.question", cue: FLY_CUE, dur: FLY_DUR, from: regionPt("pairA.transcript", PAIR.w / 2, PAIR.h - 44 - 26), to: onScreen(ASK_AT.x, ASK_AT.y, 1), arc: 320, rot: [[0, -6, 0], [0, -20, 4], [0, -12, -2]], scale: [1.12, 1], ease: "glide", fade: [0.12, 0] },
  ],
  arcs: [
    { id: "phone.answered", cue: CUES.answerDrawn - 0.5, dur: 0.5, hold: 1.0, from: onScreen(STEER_AT.x, STEER_AT.y), to: regionPt("pairA.header", 250, 22), color: "var(--sol-blue)", apex: 90 },
  ],
};
