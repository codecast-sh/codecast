// VIDEO FRAMES FROM THE VOICE HOST, for the windows that have no track.
//
// On the desktop the media lives in one window, the voice host
// (VoiceHostPanel). The header in the main window draws the same row of
// faces, and the founder wants the people he is talking to seen there, not
// their photos. A window cannot hand another a MediaStream, so the host paints
// each camera into a small square a few times a second (useFrameRelay) and
// posts the JPEGs on a BroadcastChannel; every window of the same origin
// keeps the latest one per person here, and a circle draws it when it has no
// track of its own. A channel, not a shell IPC: the installed shell needs no
// new verb, so this works on every desktop build already out there.
import { useSyncExternalStore } from "react";

const CHANNEL = "codecast-voice-frames";
const frames = new Map<string, string>();
const subs = new Set<() => void>();
let channel: BroadcastChannel | null | undefined;

function bus(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel === "undefined") return (channel = null);
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => {
      if (e.data && typeof e.data === "object") applyVoiceFrames(e.data as Record<string, string | null>);
    };
  } catch {
    channel = null;
  }
  return channel;
}

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

/** The host's side: keep them here and hand them to every other window. */
export function publishVoiceFrames(payload: Record<string, string | null>): void {
  applyVoiceFrames(payload);
  bus()?.postMessage(payload);
}

export function getVideoFrame(id: string): string | null {
  return frames.get(id) ?? null;
}

export function subscribeVideoFrames(cb: () => void): () => void {
  bus();
  subs.add(cb);
  return () => subs.delete(cb);
}

/** The latest relayed frame for a person, or null; a null id subscribes to nothing. */
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
