// The screen-tile pointer handlers, kept out of the component file: an
// export that is not a component makes the module a failed Fast Refresh
// boundary, so every save re-executes its importers (the call stage).
import { type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { getRoom, type ParticipantTile } from "../lib/calls/callManager";
import { sendCursor, sendCursorGone } from "../lib/calls/callCursors";
import { mapToFrame } from "../lib/browserWatch";

export function naturalOf(video: HTMLVideoElement | null): { width: number; height: number } | null {
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  return { width: video.videoWidth, height: video.videoHeight };
}

/** Pointer handlers for a screen tile: my pointer goes to the room. */

export function useScreenCursorSender(tile: ParticipantTile, videoRef: RefObject<HTMLVideoElement | null>) {
  const sid = tile.track.sid ?? "";
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const video = videoRef.current;
    const natural = naturalOf(video);
    if (!video || !natural || !sid) return;
    const p = mapToFrame(e.clientX, e.clientY, video.getBoundingClientRect(), natural);
    if (!p) return;
    sendCursor(getRoom(), sid, p.nx, p.ny);
  };
  const onPointerLeave = () => {
    if (sid) sendCursorGone(getRoom(), sid);
  };
  return { onPointerMove, onPointerLeave };
}

/** The other participants' cursors over this share. */
