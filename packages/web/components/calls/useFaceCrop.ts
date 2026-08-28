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
  /** The circle itself. Carries `data-tracking`, which the hook alone writes. */
  hostRef: RefObject<HTMLElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** There is a live camera track in this circle (no video, no tracking). */
  active: boolean;
  diameter: number;
  /** Your own camera: a self-view that is not mirrored looks wrong. */
  mirror: boolean;
}) {
  const { hostRef, videoRef, active, diameter, mirror } = opts;
  useWatchEffect(() => {
    // Honest about which of the two pictures this is, always. React never
    // renders this attribute, so the loop below owns it outright and no
    // re-render can put back a claim that has stopped being true.
    const setTracking = (m: "face" | "center") => hostRef.current?.setAttribute("data-tracking", m);
    setTracking("center");
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
    // One question at a time, a deadline on the answer, and a way back.
    //
    // `detect()` is not merely slow, it can fail to settle at all: it crosses
    // into a platform service (Vision on macOS), and where that service does
    // not answer — measured in headless Chromium — the promise simply hangs. A
    // sampler that fired regardless would stack an unresolved detection every
    // third of a second for the length of a call, in the window with the least
    // room to waste. So only one question is ever outstanding, and a question
    // that goes unanswered past `DETECT_DEADLINE_MS` is abandoned.
    //
    // Abandoned, not written off. The first attempt can be slow for reasons
    // that pass — a cold platform service waking up, a busy moment as the call
    // starts — and switching face tracking off for the rest of the call over
    // one slow answer is a worse failure than a few seconds of center crop. So
    // the sampler stands down and tries again, backing off each time it is
    // disappointed, up to a ceiling. Only a detector that cannot be constructed
    // is treated as permanently absent, because that one is structural.
    let inFlight = false;
    let firstAskAt = 0;
    let backoff = DETECT_RETRY_MS;
    let timer: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // Answers from before a stand-down belong to a question we stopped waiting
    // for; a late one must not be mistaken for the current attempt's.
    let askGen = 0;

    const standDown = () => {
      if (timer) clearInterval(timer);
      timer = null;
      askGen++;
      inFlight = false;
      firstAskAt = 0;
      retry = setTimeout(() => {
        if (stopped) return;
        backoff = Math.min(backoff * 2, DETECT_RETRY_MAX_MS);
        timer = setInterval(() => void sample(), SAMPLE_MS);
        void sample();
      }, backoff);
    };

    const sample = async () => {
      if (stopped || !detector) return;
      // A question already outstanding. This is where the deadline is enforced,
      // BEFORE the early return — a detection that hangs never comes back to
      // check on itself, so the only thing that can notice it is the next tick.
      if (inFlight) {
        if (firstAskAt && Date.now() - firstAskAt > DETECT_DEADLINE_MS) standDown();
        return;
      }
      if (video.videoWidth === 0) return;
      firstAskAt = Date.now();
      const gen = askGen;
      let faces: Array<{ boundingBox: FaceBox }> = [];
      inFlight = true;
      try {
        faces = await detector.detect(video);
      } catch {
        // A frame it could not read, or a detector that is not really there.
        // Same treatment as silence: stand down, come back later.
        if (gen === askGen) standDown();
        return;
      } finally {
        if (gen === askGen) inFlight = false;
      }
      if (stopped || gen !== askGen) return;
      // It answered, so this attempt is working: the backoff starts fresh and a
      // slow patch later in the call gets the same patience the first one did.
      backoff = DETECT_RETRY_MS;
      const box = faces[0]?.boundingBox;
      if (box) {
        lastFaceAt = Date.now();
        target = clampCrop(cropFromFace(box, video.videoWidth, video.videoHeight), aspect());
        setTracking("face");
      } else if (Date.now() - lastFaceAt > FACE_LOST_MS) {
        // Left the frame, turned away, or a camera pointed at a whiteboard.
        // Drifting back to the center crop is honest and never leaves the
        // circle framed on the last place a face happened to be.
        target = CENTER_CROP;
        setTracking("center");
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
      if (retry) clearTimeout(retry);
    };
  }, [hostRef, videoRef, active, diameter, mirror]);
}

/**
 * The one line the settings say about face tracking.
 *
 * There are two pictures a circle can show and they look alike at a glance: a
 * crop that follows the person, and the middle of the frame. Which one you are
 * getting depends on whether this build of Chromium has a face detector, which
 * is not something a person can be expected to know — so the settings say it
 * rather than leaving the difference to be noticed.
 */
export function faceTrackingNote(): string {
  return getFaceDetector()
    ? "Face tracking: on (Chromium FaceDetector)"
    : "Face tracking: centered (detector unavailable)";
}

/** How often the face detector is asked where the face is. */
const SAMPLE_MS = 320;
/** How long one detection may take before the sampler stops waiting for it. */
const DETECT_DEADLINE_MS = 3000;
/** How long it waits before asking again after an unanswered detection. */
const DETECT_RETRY_MS = 5000;
/** The ceiling that backoff climbs to — a detector this quiet is probably gone. */
const DETECT_RETRY_MAX_MS = 60_000;
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
 *
 * This is the ONLY permanent verdict about the detector, and it is permanent
 * because it is structural: an interface that is not on `globalThis` will not
 * appear later in the same window. A detector that merely fails to ANSWER is a
 * separate, temporary matter, handled by the sampler's backoff above.
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
