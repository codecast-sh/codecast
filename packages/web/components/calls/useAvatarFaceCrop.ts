// Centre a PHOTO circle on the person's face, once.
//
// The camera circles track a moving face at 3Hz (useFaceCrop). A photo does
// not move, so this is the same crop maths run exactly once per picture: find
// the face, compute the crop, write one transform. No sampler, no smoothing
// loop, no per-frame anything — an idle overlay must cost nothing while it
// idles.
//
// Where the detector is missing (any build without the FaceDetector flag) or
// the face is not found, the picture keeps its ordinary centred cover crop,
// which is a fine photo of a person; it just is not centred on their face.
import { type RefObject } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import {
  clampCrop,
  cropBox,
  cropFromFace,
  cropTransform,
} from "../../lib/calls/faceCrop";
import { getFaceDetector } from "./useFaceCrop";

/**
 * Find the avatar `<img>` inside `hostRef` and, when a face is detected in it,
 * re-crop the circle onto the face.
 *
 * The hook queries the DOM rather than taking an img ref because the image
 * sits behind `AvatarImg`, which renders a fallback instead of an element when
 * the bytes are unreachable — an absent img is an ordinary answer here, not an
 * error. `src` keys the work: a new resolution is a new picture and a fresh
 * detection; the crop from the old picture must never be left on the new one.
 */
export function useAvatarFaceCrop(opts: {
  /** The circle. The first `<img>` inside it is the avatar. */
  hostRef: RefObject<HTMLElement | null>;
  /** The picture's identity — re-run when it changes, skip when absent. */
  src: string | null | undefined;
  /** Skip entirely (a live camera is in this circle instead). */
  active: boolean;
  diameter: number;
}): void {
  const { hostRef, src, active, diameter } = opts;
  useWatchEffect(() => {
    if (!active || !src) return;
    const host = hostRef.current;
    const detector = getFaceDetector();
    if (!host || !detector) return;
    const img = host.querySelector("img");
    if (!img) return;

    let stopped = false;
    const detect = async () => {
      if (stopped || !(img.naturalWidth > 0)) return;
      let faces: Array<{ boundingBox: { x: number; y: number; width: number; height: number } }> = [];
      try {
        faces = await detector.detect(img);
      } catch {
        // A picture the detector cannot read (tainted, torn down mid-flight).
        // The centred cover crop it already has is the honest fallback.
        return;
      }
      const box = faces[0]?.boundingBox;
      if (stopped || !box) return;
      const aspect = img.naturalWidth / img.naturalHeight;
      const crop = clampCrop(cropFromFace(box, img.naturalWidth, img.naturalHeight), aspect);
      // The same arrangement as the video circles: the img laid out as a plain
      // diameter square, the crop applied as one composited transform.
      img.style.width = `${diameter}px`;
      img.style.height = `${diameter}px`;
      img.style.objectFit = "fill";
      img.style.transformOrigin = "0 0";
      img.style.transform = cropTransform(cropBox(crop, diameter, aspect), diameter);
      host.setAttribute("data-tracking", "face");
    };

    if (img.complete) void detect();
    else img.addEventListener("load", detect, { once: true });

    return () => {
      stopped = true;
      img.removeEventListener("load", detect);
      // A new picture (or a circle going back to video) starts from the
      // stylesheet's own crop, never from the last photo's face.
      img.style.width = "";
      img.style.height = "";
      img.style.objectFit = "";
      img.style.transformOrigin = "";
      img.style.transform = "";
      host.removeAttribute("data-tracking");
    };
  }, [hostRef, src, active, diameter]);
}
