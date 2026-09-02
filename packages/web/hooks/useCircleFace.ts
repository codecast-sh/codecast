import { useRef } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { useFaceCrop } from "../components/calls/useFaceCrop";
import { useAvatarFaceCrop } from "../components/calls/useAvatarFaceCrop";
import type { ParticipantTile } from "../lib/calls/callManager";

/**
 * A FACE IN A CIRCLE: live video when there is a camera, their picture when
 * there is not — cropped to the face either way.
 *
 * Split out of FaceCircle because two surfaces draw the same thing and had no
 * business growing two answers for it: the floating call circles, and the
 * walkie strip, which shows your own face while you hold the key. What the
 * circle MEANS is the caller's (a call seat, a person talking); what it takes
 * to keep a face centred in one is here.
 */
export function useCircleFace({
  tile,
  image,
  diameter,
  active,
}: {
  tile?: ParticipantTile;
  image?: string;
  diameter: number;
  /** False for a circle nobody can see: no detector runs for it. */
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = tile?.track;

  useWatchEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  // A circle nobody can see does not need a face tracked in it. The hook also
  // writes `data-tracking` on the circle — "face" while the detector is holding
  // one, "center" otherwise — so the picture says which of the two it is.
  useFaceCrop({ hostRef, videoRef, active: !!track && active, diameter, mirror: !!tile?.isLocal });
  // Camera off: the same centring, once, on the picture that stands in.
  useAvatarFaceCrop({ hostRef, src: image, active: !track && active, diameter });

  return { hostRef, videoRef, track };
}
