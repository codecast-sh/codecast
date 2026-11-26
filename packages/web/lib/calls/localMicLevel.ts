import { createAudioAnalyser, Track, type Room } from "livekit-client";
import { useInboxStore } from "../../store/inboxStore";
import { readMeterLevel } from "./walkieMeter";

// ── local mic level ───────────────────────────────────────────────────────
// Own-mic level for the dock meter. Polled from an AnalyserNode on the local
// mic track (livekit-client's createAudioAnalyser), fanned out through the
// same subscribe/snapshot pattern as tiles — a level is a 20fps signal and
// has no business in the store (every write would re-render every subscriber
// of the call slice).
let micLevel = 0;
const levelSubscribers = new Set<() => void>();
let levelTimer: ReturnType<typeof setInterval> | null = null;
let levelCleanup: (() => void) | null = null;

export function subscribeMicLevel(cb: () => void): () => void {
  levelSubscribers.add(cb);
  return () => levelSubscribers.delete(cb);
}
export function getMicLevel(): number {
  return micLevel;
}

export function stopLevelMeter() {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  levelCleanup?.();
  levelCleanup = null;
  if (micLevel !== 0) {
    micLevel = 0;
    for (const cb of levelSubscribers) cb();
  }
}

export function startLevelMeter(room: Room | null) {
  stopLevelMeter();
  const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track;
  if (!track || track.kind !== Track.Kind.Audio) return;
  try {
    const { analyser, cleanup } = createAudioAnalyser(track as any, {
      fftSize: 256,
      smoothingTimeConstant: 0.6,
    });
    const bytes = new Uint8Array(analyser.fftSize);
    levelCleanup = cleanup;
    levelTimer = setInterval(() => {
      // Muted → analyser reads silence anyway, but skip the work and pin 0 so
      // the meter reads honestly the instant the user mutes.
      const muted = useInboxStore.getState().call.muted;
      const v = muted ? 0 : readMeterLevel(analyser, bytes);
      if (Math.abs(v - micLevel) > 0.02 || (v === 0 && micLevel !== 0)) {
        micLevel = v;
        for (const cb of levelSubscribers) cb();
      }
    }, 50);
  } catch {}
}
