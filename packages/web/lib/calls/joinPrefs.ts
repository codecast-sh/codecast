// What the person's microphone and camera do when they join a call on purpose,
// so a join never asks them again and never surprises them.
//
// The founder's two sentences: "make sure your mics are not muted by default
// ever and probably just have our previous mic/camera settings saved and turned
// on to that mic/camera auto always", and later "turn people's cameras on by
// default and make that sticky as well as their mic setting". Three kinds of
// fact live in those sentences, and they belong in three different places:
//
//   WHICH DEVICE is a fact about the MACHINE. The headset plugged into the
//   laptop has an id that means nothing on the desktop, so these keys stay
//   unstamped in the client prefs bag — per device, like `people_view`.
//   WHETHER THE CAMERA IS ON and WHETHER THE MIC IS ON are facts about the
//   PERSON. Somebody who joins with video joins with video wherever they are,
//   so both are stamped LWW and follow them.
//   THE DEFAULT, when nothing has been chosen yet, is ON for both. A call is
//   for being seen and heard; a person who wants otherwise turns it off once
//   and it stays off. An absent key therefore reads as `true`, and only an
//   explicit `false` reads as off — the reason both reads below compare
//   against `false` rather than coercing.
//
// STICKY means the last choice made INSIDE a call is the next join's start.
// `setCamera` and `setMuted` write here on the person's own toggles; the
// engine's own opens and closes (a walkie burst, a snooze, a join applying
// these very prefs) pass `remember: false` and leave the choice alone.
import { useInboxStore } from "../../store/inboxStore";

export type JoinPrefs = {
  /** The microphone to open. Undefined means "whatever the browser picks". */
  micDeviceId?: string;
  cameraDeviceId?: string;
  /** Whether a deliberate join turns the camera on. On until turned off once. */
  cameraOn: boolean;
  /** Whether a deliberate join opens the microphone. On until muted once. */
  micOn: boolean;
};

function ui(): any {
  return (useInboxStore.getState() as any).clientState?.ui ?? {};
}

export function readJoinPrefs(): JoinPrefs {
  const u = ui();
  return {
    micDeviceId: u.call_mic_device_id || undefined,
    cameraDeviceId: u.call_camera_device_id || undefined,
    cameraOn: u.call_camera_on !== false,
    micOn: u.call_mic_on !== false,
  };
}

/** The person picked a device in a picker. Remember it for the next join —
 *  that is the whole of "devices remembered". */
export function rememberDevice(kind: "audioinput" | "videoinput", deviceId: string): void {
  if (!deviceId) return;
  const key = kind === "audioinput" ? "call_mic_device_id" : "call_camera_device_id";
  if (ui()[key] === deviceId) return;
  useInboxStore.getState().updateClientUI({ [key]: deviceId } as any);
}

/** The camera went on or off by the person's hand. The NEXT deliberate join
 *  starts the way this one ended. */
export function rememberCamera(on: boolean): void {
  if (readJoinPrefs().cameraOn === on) return;
  useInboxStore.getState().updateClientUI({ call_camera_on: on });
}

/** The microphone went on or off by the person's hand. Same rule. */
export function rememberMic(on: boolean): void {
  if (readJoinPrefs().micOn === on) return;
  useInboxStore.getState().updateClientUI({ call_mic_on: on });
}

/**
 * The capture constraints every join hands to the media plane.
 *
 * `echoCancellation` is the one that is not a preference. The burst coming out
 * of a listener's speakers is arriving at their own microphone the moment they
 * step in — without cancellation that is a loop, and the sender hears
 * themselves a beat late. It is on by default in Chromium for `audio: true`,
 * and stating it is the difference between relying on a default and meaning it.
 */
export function micConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}
