// The huddle ring — a synthesized bell motif bundled with the app, looped
// while an invite is live. One module-level player so a re-render can never
// stack two rings; CallOverlay drives start/stop off the invite diff.
//
// Deliberate behaviors:
// - Respects the iOS silent switch (a ring is a courtesy, not an alarm).
// - Never rings while already connected to a call — the banner alone carries
//   a second incoming ring (same contract as web's useCallRing).
// - Audio-session config is only touched while ringing and only when idle:
//   the LiveKit AudioSession owns the category during a call, and clobbering
//   it mid-call breaks call audio.
import { getCallSnapshot } from "./callManager";

// expo-audio is a NATIVE dependency loaded lazily and guarded: a JS bundle
// (OTA or dev-server) newer than the installed binary must degrade to a
// silent banner + haptics, never crash at import. This is the exact skew
// class that took the app down twice before (gesture-handler, notifications).
let audio: typeof import("expo-audio") | null | undefined;
function getAudio() {
  if (audio !== undefined) return audio;
  try {
    audio = require("expo-audio");
  } catch {
    audio = null;
  }
  return audio;
}

// 3.0s cell: two bell phrases + a breath. Looping the file gives the classic
// ring cadence without a timer.
const RING_ASSET = require("../../assets/sounds/huddle-ring.m4a");

let player: import("expo-audio").AudioPlayer | null = null;
let ringing = false;

export async function startRinging(): Promise<void> {
  if (ringing) return;
  if (getCallSnapshot().phase === "connected") return;
  ringing = true;
  const a = getAudio();
  if (!a) return;
  try {
    await a.setAudioModeAsync({ playsInSilentMode: false });
    if (!player) {
      player = a.createAudioPlayer(RING_ASSET);
      player.loop = true;
    }
    player.seekTo(0);
    player.play();
  } catch {
    // A ring that can't sound still shows the banner + haptics.
  }
}

export function stopRinging(): void {
  if (!ringing) return;
  ringing = false;
  try {
    player?.pause();
    player?.seekTo(0);
  } catch {}
}

export function isRinging(): boolean {
  return ringing;
}

// Dev-only harness hook (same convention as __call in callManager): the
// simulator e2e asserts ring state over the Hermes inspector.
if (__DEV__) {
  (global as any).__ring = {
    isRinging,
    playing: () => !!player?.playing,
    start: startRinging,
    stop: stopRinging,
  };
}
