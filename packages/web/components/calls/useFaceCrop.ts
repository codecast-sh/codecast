import { type RefObject } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import {
  CENTER_CROP,
  clampCrop,
  cropBox,
  cropFromFace,
  cropTransform,
  lerpCrop,
  type Crop,
  type FaceBox,
} from "../../lib/calls/faceCrop";

/**
 * Keep a person's face in the middle of a circle while they move.
 *
 * Two loops with different clocks, which is the whole design:
 *
 *   the SAMPLER runs at 3Hz and asks where the face is. Face detection is
 *   expensive and a head does not move fast, so asking more often would cost
 *   battery to learn nothing.
 *
 *   the SMOOTHER runs at the display's rate and moves the crop a fraction of
 *   the way toward the sampler's answer. Without it the circle would jump three
 *   times a second, which reads as a broken video rather than a moving person.
 *
 * Neither touches React. The crop lives in closure variables and reaches the
 * screen as one transform written straight to the element — a React state
 * update per frame per face would re-render the window sixty times a second to
 * move a circle a pixel.
 */
export function useFaceCrop(opts: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** There is a live camera track in this circle (no video, no tracking). */
  active: boolean;
  diameter: number;
  /** Your own camera: a self-view that is not mirrored looks wrong. */
  mirror: boolean;
}) {
  const { videoRef, active, diameter, mirror } = opts;
  useWatchEffect(() => {
    const video = videoRef.current;
    if (!video || !active) return;

    let crop: Crop = CENTER_CROP;
    let target: Crop = CENTER_CROP;
    let lastFaceAt = 0;
    let raf = 0;
    let stopped = false;
    const smooth = !prefersReducedMotion();

    const aspect = () =>
      video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;

    const paint = () => {
      video.style.transform = cropTransform(cropBox(crop, diameter, aspect()), diameter, mirror);
    };
    // Paint once immediately: until the first sample lands the circle shows the
    // middle of the frame, which is a face often enough and never a hole.
    paint();

    const detector = getFaceDetector();
    // One question at a time, and a deadline on the first answer.
    //
    // `detect()` is not merely slow, it can never settle: it crosses into a
    // platform service (Vision on macOS), and where that service does not
    // answer — measured in headless Chromium — the promise simply hangs. A
    // sampler that fires regardless would stack an unresolved detection every
    // third of a second for the length of a call, in the window that has the
    // least room to waste. So: skip while one is outstanding, and if the very
    // first one has not come back by `DETECT_DEADLINE_MS`, treat the detector
    // as absent for this window and live on the center crop.
    let inFlight = false;
    let answered = false;
    let firstAskAt = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const giveUp = () => {
      detectorState = "absent";
      if (timer) clearInterval(timer);
      timer = null;
    };
    const sample = async () => {
      if (stopped || !detector || inFlight || video.videoWidth === 0) return;
      if (!answered && firstAskAt && Date.now() - firstAskAt > DETECT_DEADLINE_MS) return giveUp();
      if (!firstAskAt) firstAskAt = Date.now();
      let faces: Array<{ boundingBox: FaceBox }> = [];
      inFlight = true;
      try {
        faces = await detector.detect(video);
        answered = true;
      } catch {
        // A detector that throws once throws every time (an unsupported build,
        // a frame it cannot read). Stop asking and live on the center crop.
        return giveUp();
      } finally {
        inFlight = false;
      }
      if (stopped) return;
      const box = faces[0]?.boundingBox;
      if (box) {
        lastFaceAt = Date.now();
        target = clampCrop(cropFromFace(box, video.videoWidth, video.videoHeight), aspect());
      } else if (Date.now() - lastFaceAt > FACE_LOST_MS) {
        // Left the frame, turned away, or a camera pointed at a whiteboard.
        // Drifting back to the center crop is honest and never leaves the
        // circle framed on the last place a face happened to be.
        target = CENTER_CROP;
      }
    };
    if (detector) timer = setInterval(() => void sample(), SAMPLE_MS);
    void sample();

    const tick = () => {
      if (stopped) return;
      const next = smooth ? lerpCrop(crop, target, SMOOTHING) : target;
      if (next !== crop) {
        crop = next;
        paint();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
    };
  }, [videoRef, active, diameter, mirror]);
}

/** How often the face detector is asked where the face is. */
const SAMPLE_MS = 320;
/** How long the first detection may take before the detector is written off. */
const DETECT_DEADLINE_MS = 3000;
/** How long a face may be missing before the circle drifts back to center. */
const FACE_LOST_MS = 2000;
/** How much of the remaining distance the crop covers each frame. */
const SMOOTHING = 0.14;

type Detector = { detect: (source: CanvasImageSource) => Promise<Array<{ boundingBox: FaceBox }>> };

let detectorState: "unknown" | "ok" | "absent" = "unknown";
let detector: Detector | null = null;

/**
 * The Shape Detection API's face detector, if this browser has one.
 *
 * Chromium ships `FaceDetector` on macOS, backed by the system's own detector,
 * and does not on every platform or build — so this is asked for rather than
 * assumed, once per window, and everything downstream treats `null` as an
 * ordinary answer. Without it the circles show a center crop, which is a
 * perfectly good picture of somebody sitting at their desk; it just does not
 * follow them.
 */
export function getFaceDetector(): Detector | null {
  if (detectorState === "unknown") {
    const Ctor = (globalThis as any).FaceDetector;
    try {
      detector = typeof Ctor === "function" ? new Ctor({ maxDetectedFaces: 1, fastMode: true }) : null;
    } catch {
      detector = null;
    }
    detectorState = detector ? "ok" : "absent";
  }
  return detectorState === "ok" ? detector : null;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}
