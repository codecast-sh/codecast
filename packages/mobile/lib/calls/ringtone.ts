// The huddle ring — a synthesized bell motif bundled with the app, looped
// while an invite is live. One module-level player so a re-render can never
// stack two rings; CallOverlay drives start/stop off the invite diff.
//
// Deliberate behaviors:
// - Respects the iOS silent switch (a ring is a courtesy, not an alarm).
// - Never rings while a call OWNS the audio session (connecting, reconnecting,
//   connected): expo-audio's mode change flips the process-wide AVAudioSession
//   to ambient under a live capture, and pausing would deactivate it. 'error'
//   stays ringable — media is torn down there and the phase can linger.
// - keepAudioSessionActive: pausing the ring must never deactivate the shared
//   session out from under LiveKit.
// - Start/stop are generation-guarded: an interruption (phone call, Siri) can
//   resurrect a paused player, and a stop that lands mid-start must win.
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

// 3.0s cell (CALL_RING_PERIOD_MS): two bell phrases + a breath. Looping the
// file gives the classic ring cadence without a timer.
const RING_ASSET = require("../../assets/sounds/huddle-ring.m4a");

let player: import("expo-audio").AudioPlayer | null = null;
let ringing = false;
let startGen = 0;

function callOwnsAudio(): boolean {
  const p = getCallSnapshot().phase;
  return p === "connecting" || p === "connected";
}

export async function startRinging(): Promise<void> {
  if (ringing) return;
  if (callOwnsAudio()) return;
  ringing = true;
  const gen = ++startGen;
  const a = getAudio();
  if (!a) return;
  try {
    await a.setAudioModeAsync({ playsInSilentMode: false });
    // A stop (or a call start) landed while we awaited: do not resurrect.
    if (!ringing || gen !== startGen || callOwnsAudio()) {
      ringing = false;
      return;
    }
    if (!player) {
      player = a.createAudioPlayer(RING_ASSET, { keepAudioSessionActive: true });
      player.loop = true;
    }
    player.seekTo(0);
    player.play();
  } catch {
    // A ring that can't sound still shows the banner + haptics.
  }
}

export function stopRinging(): void {
  // Unconditional: never gate the player cleanup on `ringing` — an
  // interruption can leave the native player looping with ringing=false.
  ringing = false;
  startGen++;
  try {
    player?.pause();
    player?.remove();
  } catch {}
  player = null;
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
