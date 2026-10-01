// The screen-tile pointer handlers, kept out of the component file: an
// export that is not a component makes the module a failed Fast Refresh
// boundary, so every save re-executes its importers (the call stage).
import { useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useWatchEffect } from "./useWatchEffect";
import type { Room } from "livekit-client";
import type { ParticipantTile } from "../lib/calls/callMedia";
import { sendCursor, sendCursorGone } from "../lib/calls/callCursors";
import { mapToFrame } from "../lib/browserWatch";

export function naturalOf(video: HTMLVideoElement | null): { width: number; height: number } | null {
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  return { width: video.videoWidth, height: video.videoHeight };
}

type NaturalSize = { width: number; height: number };

/** The video's own pixel size, live: it arrives with the metadata after mount
 *  and changes when the sharer resizes what they share. `key` re-arms the
 *  listeners when the element's stream changes (the tile's track). */
export function useNaturalSize(videoRef: RefObject<HTMLVideoElement | null>, key: unknown): NaturalSize | null {
  const [natural, setNatural] = useState<NaturalSize | null>(null);
  useWatchEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const read = () => {
      const n = naturalOf(video);
      setNatural((prev) => (n && prev && n.width === prev.width && n.height === prev.height ? prev : n));
    };
    read();
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("resize", read);
    return () => {
      video.removeEventListener("loadedmetadata", read);
      video.removeEventListener("resize", read);
    };
  }, [videoRef, key]);
  return natural;
}

/** Pointer handlers for a screen tile: my pointer goes to the room. The room
 *  is asked for, not imported: a member's comes from the call manager, a
 *  guest's from their own page (lib/calls/guestRoom). */
export function useScreenCursorSender(
  tile: ParticipantTile,
  videoRef: RefObject<HTMLVideoElement | null>,
  getRoom: () => Room | null,
) {
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
