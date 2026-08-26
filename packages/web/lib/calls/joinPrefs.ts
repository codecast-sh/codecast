// What the person's microphone and camera were doing last time they joined a
// call on purpose, so the next deliberate join does not ask them again.
//
// The founder's sentence: "make sure your mics are not muted by default ever
// and probably just have our previous mic/camera settings saved and turned on
// to that mic/camera auto always". Two different kinds of fact live in that
// sentence, and they belong in two different places:
//
//   WHICH DEVICE is a fact about the MACHINE. The headset plugged into the
//   laptop has an id that means nothing on the desktop, so these keys stay
//   unstamped in the client prefs bag — per device, like `people_view`.
//   WHETHER THE CAMERA WAS ON is a fact about the PERSON. Somebody who joins
//   with video joins with video wherever they are, so that one is stamped LWW
//   and follows them.
//
// The mic is not stored at all, because it has no state worth remembering: a
// deliberate join is always unmuted now. That is the decision, not a default.
import { useInboxStore } from "../../store/inboxStore";

export type JoinPrefs = {
  /** The microphone to open. Undefined means "whatever the browser picks". */
  micDeviceId?: string;
  cameraDeviceId?: string;
  /** Whether a deliberate join turns the camera on. Off until they turn it on
   *  once — a call that opens your camera unasked is the wrong surprise. */
  cameraOn: boolean;
};

function ui(): any {
  return (useInboxStore.getState() as any).clientState?.ui ?? {};
}

export function readJoinPrefs(): JoinPrefs {
  const u = ui();
  return {
    micDeviceId: u.call_mic_device_id || undefined,
    cameraDeviceId: u.call_camera_device_id || undefined,
    cameraOn: !!u.call_camera_on,
  };
}

/** The person picked a device in the stage's picker. Remember it for the next
 *  join — that is the whole of "devices remembered". */
export function rememberDevice(kind: "audioinput" | "videoinput", deviceId: string): void {
  if (!deviceId) return;
  const key = kind === "audioinput" ? "call_mic_device_id" : "call_camera_device_id";
  if (ui()[key] === deviceId) return;
  useInboxStore.getState().updateClientUI({ [key]: deviceId } as any);
}

/** The camera went on or off during a call. The NEXT deliberate join starts
 *  the way this one ended. */
export function rememberCamera(on: boolean): void {
  if (!!ui().call_camera_on === on) return;
  useInboxStore.getState().updateClientUI({ call_camera_on: on });
}

/**
 * The capture constraints every join hands to the media plane.
 *
 * `echoCancellation` is the one that is not a preference. A receiver now
 * auto-listens with a HOT MICROPHONE, so the burst coming out of their
 * speakers is arriving at their own open mic — without cancellation that is a
 * loop, and the sender hears themselves a beat late. It is on by default in
 * Chromium for `audio: true`, and stating it is the difference between relying
 * on a default and meaning it.
 */
export function micConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}
