// THE HOST PAINTS ITS CAMERAS FOR THE OTHER WINDOWS (lib/calls/videoFrames).
//
// The voice host owns every video track. The header in the main window shows
// the same faces and has no track to draw, so the host keeps a hidden <video>
// per camera, paints a small square of each a few times a second and relays
// the JPEGs on a BroadcastChannel. Small on purpose: the far side draws a 32px or a
// 64px circle, so 96px is plenty and a frame is a few kilobytes.
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { getCallTiles, subscribeCallTiles } from "../../lib/calls/callManager";
import { publishVoiceFrames } from "../../lib/calls/videoFrames";

export const FRAME_PX = 96;
export const FRAME_INTERVAL_MS = 125;

export function useFrameRelay(enabled: boolean): void {
  useWatchEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const videos = new Map<string, { el: HTMLVideoElement; track: { detach: (el: HTMLMediaElement) => unknown } }>();
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_PX;
    canvas.height = FRAME_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // One hidden video per camera track, for as long as the track is there.
    const sync = () => {
      const seen = new Set<string>();
      for (const tile of getCallTiles()) {
        if (tile.kind !== "camera") continue;
        seen.add(tile.identity);
        if (videos.has(tile.identity)) continue;
        const el = document.createElement("video");
        el.muted = true;
        el.playsInline = true;
        el.autoplay = true;
        el.style.position = "fixed";
        el.style.width = "1px";
        el.style.height = "1px";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        (tile.track as any).attach(el);
        document.body.appendChild(el);
        void el.play?.().catch(() => {});
        videos.set(tile.identity, { el, track: tile.track as any });
      }
      const gone: Record<string, null> = {};
      for (const [id, v] of videos) {
        if (seen.has(id)) continue;
        v.track.detach(v.el);
        v.el.remove();
        videos.delete(id);
        gone[id] = null;
      }
      if (Object.keys(gone).length) publishVoiceFrames(gone);
    };
    const unsubscribe = subscribeCallTiles(sync);
    sync();

    const timer = setInterval(() => {
      const out: Record<string, string> = {};
      for (const [id, { el }] of videos) {
        const w = el.videoWidth;
        const h = el.videoHeight;
        if (!w || !h) continue;
        // A centred square: the circle on the far side crops the rest.
        const side = Math.min(w, h);
        ctx.drawImage(el, (w - side) / 2, (h - side) / 2, side, side, 0, 0, FRAME_PX, FRAME_PX);
        out[id] = canvas.toDataURL("image/jpeg", 0.55);
      }
      if (Object.keys(out).length) publishVoiceFrames(out);
    }, FRAME_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      unsubscribe();
      const gone: Record<string, null> = {};
      for (const [id, v] of videos) {
        v.track.detach(v.el);
        v.el.remove();
        gone[id] = null;
      }
      videos.clear();
      if (Object.keys(gone).length) publishVoiceFrames(gone);
    };
  }, [enabled]);
}
