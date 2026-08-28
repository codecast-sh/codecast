// WHO OWNS THE MICROPHONE. This module does, and that inversion is what made
// the walkie work. Joining the room first and borrowing LiveKit's published
// track put a token mint and an SFU connect between the key going down and
// anything listening — 1.0s warm, 12.7s cold — and everything said in that gap
// reached nobody and landed in no recording, so a two second burst came back as
// "no words".
//
// So the device is opened first and the room joins behind it holding a CLONE. A
// clone shares the one capture without sharing its lifetime, so callManager may
// own, mute and stop its copy exactly as it owns every published track, and a
// room closing mid-word cannot truncate the recording.
//
// The track outlives the burst by a minute: the second press is the one that
// has to feel instant, and getUserMedia on an already-granted device is still
// tens of milliseconds of work.
import { Track } from "livekit-client";
import { getRoom, mediaFailureReason } from "./callManager";
import { bindPrewarmMic } from "./roomPrewarm";
import { micConstraints, readJoinPrefs } from "./joinPrefs";

/** The track already published into the room this client is sitting in —
 *  hold-to-reply inside a huddle borrows it rather than opening a second. */
export function localMicTrack(): MediaStreamTrack | null {
  const pub = getRoom()?.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track?.mediaStreamTrack;
  return track && track.readyState === "live" ? track : null;
}

// ── the microphone ──────────────────────────────────────────────────────────
//
// The walkie holds its own, and the room joins behind it holding a CLONE. A
// clone shares the one capture without sharing its lifetime, so callManager may
// own, mute and stop its copy exactly as it owns every published track, and a
// room closing mid-word cannot truncate the recording.
//
// The track outlives the burst by a minute: the second press is the one that
// has to feel instant, and getUserMedia on an already-granted device is still
// tens of milliseconds of work.

/** How long an unused microphone is held before it is given back. Long enough
 *  to cover a conversation's back-and-forth, short enough that the browser's
 *  recording indicator is not left on after somebody walks away. */
const MIC_IDLE_MS = 60_000;

let mic: MediaStreamTrack | null = null;
let micPending: Promise<MediaStreamTrack | null> | null = null;
let micIdleTimer: ReturnType<typeof setTimeout> | null = null;
/** A press has been granted the microphone at least once in this tab, so
 *  asking again cannot raise a prompt. The Permissions API answers the same
 *  question where it supports "microphone"; this covers the browsers where it
 *  does not. */
let micGranted = false;

function heldMic(): MediaStreamTrack | null {
  if (mic && mic.readyState === "live") return mic;
  mic = null;
  return null;
}

function stopMic() {
  try {
    mic?.stop();
  } catch {}
  mic = null;
}

/** Whether the device is still doing something, which is the only thing this
 *  file needs from the state machine next door: a burst in flight keeps its
 *  microphone however long the person holds the key. Injected rather than
 *  imported, so this file has no opinion about what a burst is. */
let inUse: () => boolean = () => false;

export function bindMicInUse(fn: () => boolean): void {
  inUse = fn;
}

/** Start the clock on giving the microphone back. */
export function releaseMicLater() {
  if (micIdleTimer) clearTimeout(micIdleTimer);
  micIdleTimer = setTimeout(() => {
    micIdleTimer = null;
    if (inUse()) return;
    stopMic();
  }, MIC_IDLE_MS);
}

/** Open the microphone, or hand back the one already open. Concurrent callers
 *  share one getUserMedia — two push-to-talk surfaces under one pointer must
 *  not open two devices. */
// Why the last acquire failed, kept because the caller needs it to say anything
// useful: `mediaFailureReason` reads the DOMException's name to tell "no
// microphone here" from "you said no" from "the browser has not asked yet", and
// swallowing it flattened all three into "Microphone unavailable".
let lastMicError: unknown = null;

export function acquireMic(): Promise<MediaStreamTrack | null> {
  const held = heldMic();
  if (held) return Promise.resolve(held);
  if (!micPending) {
    micPending = (async () => {
      try {
        // ECHO CANCELLATION IS NOT A PREFERENCE HERE. The receiver
        // auto-listens with a hot microphone, so the burst coming out of their
        // speakers arrives back at their own open mic. Chromium turns it on for
        // `audio: true` anyway; saying it is the difference between relying on
        // a default and meaning it. The device is the one they last chose in a
        // call, so a burst and a huddle never disagree about whose mic is
        // whose.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(readJoinPrefs().micDeviceId),
        });
        const track = stream.getAudioTracks()[0] ?? null;
        if (track) {
          mic = track;
          micGranted = true;
          lastMicError = null;
        }
        return track;
      } catch (err) {
        lastMicError = err;
        return null;
      } finally {
        micPending = null;
      }
    })();
  }
  return micPending;
}

/** Whether asking for the microphone right now is certain not to prompt. */
async function micAlreadyGranted(): Promise<boolean> {
  if (micGranted) return true;
  try {
    const perm = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return perm.state === "granted";
  } catch {
    // A browser with no Permissions API entry for the microphone cannot tell us,
    // and the whole point of a pre-warm is that it is invisible. Never guess.
    return false;
  }
}

/**
 * Open the microphone BEFORE the key goes down, so the first burst is as fast
 * as the second. Called on pointer enter of a push-to-talk surface — a gesture
 * that means "might talk", not "am talking".
 *
 * IT MUST NEVER PROMPT. A permission dialog raised by a pointer passing over a
 * button is an ambush: the person never asked for the microphone, cannot tell
 * what asked, and a denial then blocks the real press. So this proceeds only
 * where the answer is already yes, and a real press is the only thing allowed
 * to raise the question.
 */
export async function warmMic(): Promise<void> {
  if (heldMic() || micPending) {
    releaseMicLater();
    return;
  }
  if (!(await micAlreadyGranted())) return;
  await acquireMic();
  releaseMicLater();
}

/** What went wrong the last time the microphone was asked for, in the words a
 *  person can act on. `mediaFailureReason` reads the DOMException's name to
 *  tell "no microphone here" from "you said no" from "the browser has not asked
 *  yet"; swallowing it flattened all three into "Microphone unavailable". */
export function micFailureReason(): Promise<string> {
  return mediaFailureReason("microphone", lastMicError);
}


// THE PREWARM USES THIS DEVICE, not one of its own.
//
// A prewarmed room publishes a muted microphone so the far side has already
// negotiated the track before anybody presses (the founder's call: the
// recording indicator lights on hover, and a press becomes an unmute rather
// than a publish). It has to be THIS module's device — a second getUserMedia
// would be a second entry in the browser's indicator, a second echo path, and
// a second thing to remember to close.
//
// Registered from this side rather than imported from the other, for the same
// reason `bindMicInUse` is injected: `callManager` sits between this file and
// the prewarm, so an import the other way would close a cycle.
//
// `warmMic` and nothing else, so the rule that a hover can never raise a
// permission dialog survives the change: where permission has not already been
// granted this hands back null and the prewarm simply stays silent.
bindPrewarmMic(async () => {
  await warmMic();
  return heldMic();
});
