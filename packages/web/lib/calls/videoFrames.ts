// VIDEO FRAMES FROM THE VOICE HOST, for the windows that have no track.
//
// On the desktop the media lives in one window, the voice host (VoiceHostPanel).
// The header in the main window draws the same row of faces, and the founder
// wants the people he is talking to seen there, not their photos. A window
// cannot hand another a MediaStream, so the host paints each camera into a
// small square at a few frames a second and relays the JPEGs over the shell
// (useFrameRelay, "voice-frames"); every other window keeps the latest one per
// person here and the circle draws it when it has no track of its own.
import { useSyncExternalStore } from "react";

const frames = new Map<string, string>();
const subs = new Set<() => void>();

/** The host's latest frames by LiveKit identity (a user id). `null` drops one. */
export function applyVoiceFrames(payload: Record<string, string | null>): void {
  let changed = false;
  for (const [id, url] of Object.entries(payload)) {
    if (url) {
      if (frames.get(id) !== url) {
        frames.set(id, url);
        changed = true;
      }
    } else if (frames.delete(id)) changed = true;
  }
  if (changed) for (const cb of subs) cb();
}

export function getVideoFrame(id: string): string | null {
  return frames.get(id) ?? null;
}

export function subscribeVideoFrames(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** The latest relayed frame for a person, or null; null id subscribes to nothing. */
export function useVideoFrame(id: string | null): string | null {
  return useSyncExternalStore(
    subscribeVideoFrames,
    () => (id ? getVideoFrame(id) : null),
    () => null,
  );
}

/** Test and dev seam: forget every frame. */
export function clearVideoFrames(): void {
  if (frames.size === 0) return;
  frames.clear();
  for (const cb of subs) cb();
}
