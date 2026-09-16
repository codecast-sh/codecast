"use client";

import { useReducer, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { getRoom, type ParticipantTile } from "../../lib/calls/callManager";
import { getCallCursors, nextCursorExpiryAt, sendCursor, sendCursorGone, subscribeCallCursors } from "../../lib/calls/callCursors";
import { mapFromFrame, mapToFrame } from "../../lib/browserWatch";
import { hueFor } from "../../lib/avatarInitials";
import { useDerivedSize } from "../../hooks/useDerivedSize";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { CursorArrow } from "../presence/CursorArrow";
import { firstName } from "./speakers";

// Teammates' cursors over a screen share tile, and mine going out.
//
// Geometry: a screen tile renders object contain, so the share's content rect
// is its aspect fit inside the tile box; mapToFrame turns my pointer into a
// point on the share's own pixels, and mapFromFrame puts a teammate's point
// back onto my tile. The natural size is the video's own (videoWidth and
// videoHeight), which the browser knows once metadata has loaded.
//
// Colour is the owner's avatar hue (hueFor), the same colour their initials
// wear when they have no picture, so the arrow and the face agree.

const TRANSITION = "transform 120ms cubic-bezier(.2,.7,.2,1), opacity 300ms ease";

function naturalOf(video: HTMLVideoElement | null): { width: number; height: number } | null {
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
export function ScreenCursors({
  tile,
  boxRef,
  videoRef,
}: {
  tile: ParticipantTile;
  boxRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const cursors = useSyncExternalStore(subscribeCallCursors, getCallCursors, getCallCursors);
  const sid = tile.track.sid ?? "";
  const me = getRoom()?.localParticipant.identity ?? null;
  // The tile only re-renders this overlay when its rounded size changes.
  const boxSig = useDerivedSize(boxRef, (w, h) => `${Math.round(w)}x${Math.round(h)}`, () => "0x0");
  const [boxW, boxH] = boxSig.split("x").map(Number);
  // The video's natural size arrives with its metadata, after mount.
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const naturalRef = useRef<{ width: number; height: number } | null>(null);
  useWatchEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const read = () => {
      const n = naturalOf(video);
      if (n && (n.width !== naturalRef.current?.width || n.height !== naturalRef.current?.height)) {
        naturalRef.current = n;
        wake();
      }
    };
    read();
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("resize", read);
    return () => {
      video.removeEventListener("loadedmetadata", read);
      video.removeEventListener("resize", read);
    };
  }, [videoRef, tile.track]);
  // A cursor leaving is a question of time: wake when the next one expires.
  const expiry = nextCursorExpiryAt(cursors);
  useWatchEffect(() => {
    if (expiry === null) return;
    const t = setTimeout(wake, Math.max(0, expiry - Date.now()) + 16);
    return () => clearTimeout(t);
  }, [expiry]);

  const natural = naturalRef.current ?? naturalOf(videoRef.current);
  if (!natural || !sid) return null;
  const box = { left: 0, top: 0, width: boxW, height: boxH };
  const shown = [...cursors.values()].filter((c) => c.sid === sid && c.identity !== me);
  if (shown.length === 0) return null;
  return (
    <div data-sv-screen-cursors={shown.length} className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {shown.map((c) => {
        const p = mapFromFrame(c.nx, c.ny, box, natural);
        if (!p) return null;
        return (
          <div
            key={c.identity}
            data-sv-screen-cursor={c.identity}
            className="absolute left-0 top-0 w-7 h-9 will-change-transform"
            style={{ transform: `translate(${p.x}px, ${p.y}px)`, transition: TRANSITION }}
          >
            <CursorArrow color={hueFor(c.name)} label={firstName(c.name)} />
          </div>
        );
      })}
    </div>
  );
}
