/**
 * Chapter 4, Approve: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "phone." (see contract.ts).
 *
 * The ask lands at the foot of the API worker's pane as the permission stack,
 * flies to the phone as the daemon's push, opens into the app's permission
 * card, and the tap on Approve draws back to the worker.
 */

import { CUES } from "../fixtures/story";
import { localToWorld, regionPt } from "../world";
import type { ChapterMotion } from "./contract";

/** The phone's moments, read by the views (state) and the beats below (motion). */
export const PHONE_AT = {
  /** The push lands on the lock screen as the flyer arrives. */
  banner: 24.0,
  /** The push opens into the app. */
  open: 24.6,
  /** Approve is tapped: the card shows its in-flight label, then leaves. */
  tap: CUES.permissionApproved,
  gone: CUES.permissionCleared,
  /** The worker finishes the approved run and the app says so. */
  done: 26.3,
} as const;

export const motion: ChapterMotion = {
  beats: {
    // The dashboard worker steps back for the ask, and comes forward again for Talk.
    pairB: [
      { id: "phone.veil", cue: 20.9, dur: 0.5, preset: "fadeIn" },
      { id: "phone.veil", cue: 29.2, dur: 0.5, preset: "fadeOut" },
    ],
    pairA: [
      { id: "phone.stack", cue: CUES.permissionAsk, preset: "drop", z: 160, rx: -14, y: 18 },
      { id: "phone.stack", cue: CUES.permissionCleared - 0.25, dur: 0.25, preset: "fadeOut" },
    ],
    phone: [
      { id: "phone.banner", cue: PHONE_AT.banner, preset: "drop", z: 160, rx: -14, y: -30 },
      { id: "phone.banner", cue: PHONE_AT.open - 0.05, preset: "liftOut", dur: 0.35, y: 30, z: 60 },
      { id: "phone.banner", cue: PHONE_AT.open - 0.05, preset: "fadeOut", dur: 0.3 },
      { id: "phone.lock", cue: PHONE_AT.open - 0.05, preset: "fadeOut", dur: 0.4 },
      { id: "phone.app", cue: PHONE_AT.open, preset: "fadeIn", dur: 0.35 },
      { id: "phone.row", cue: PHONE_AT.open, preset: "drop", z: 120, rx: -10, y: -14 },
      { id: "phone.card", cue: PHONE_AT.open + 0.12, preset: "drop", z: 140, rx: -12, y: -16 },
      { id: "phone.tap", cue: PHONE_AT.tap - 0.05, preset: "ring", dur: 0.6 },
      { id: "phone.done", cue: PHONE_AT.done, preset: "drop", z: 120, rx: -10, y: -14 },
    ],
  },
  flyers: [
    { id: "phone.permission", cue: 23.1, dur: 0.85, from: regionPt("pairA.transcript", 270, 250), to: localToWorld("phone", 0, -90, 8), arc: 320, rot: [[0, -6, 0], [0, -20, 4], [0, -12, -2]], scale: [1, 0.86], ease: "glide", fade: [0.1, 0.08] },
  ],
  arcs: [
    { id: "phone.approved", cue: CUES.approvalDrawn - 0.5, dur: 0.5, hold: 0.8, from: localToWorld("phone", -60, -300), to: regionPt("pairA.header", 250, 22), color: "var(--sol-green)", apex: 90 },
  ],
};
