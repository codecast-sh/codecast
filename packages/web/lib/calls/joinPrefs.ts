// What the person's microphone and camera do when they join a call on purpose,
// so a join never asks them again and never surprises them.
//
// The founder's two sentences: "make sure your mics are not muted by default
// ever and probably just have our previous mic/camera settings saved and turned
// on to that mic/camera auto always", and later "turn people's cameras on by
// default and make that sticky as well as their mic setting". Three kinds of
// fact live in those sentences, and they belong in three different places:
//
//   WHICH DEVICE is a ranking of devices by name (lib/calls/deviceRank),
//   resolved against what is plugged in at the moment of asking. The same
//   headphones are the same headphones on every machine, so it is stamped and
//   follows the person; a device one machine lacks never matches there.
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
import { DEVICE_RANK_KEY, knownDevices, rankAfterPick, resolveDevice, trackOnDevice, type DeviceKind } from "./deviceRank";

export type JoinPrefs = {
  /** The microphone to open. Undefined means "whatever the browser picks". */
  micDeviceId?: string;
  cameraDeviceId?: string;
  /** The speaker a join plays through. Undefined means the system output. */
  speakerDeviceId?: string;
  /** Whether a deliberate join turns the camera on. On until turned off once. */
  cameraOn: boolean;
  /** Whether a deliberate join opens the microphone. On until muted once. */
  micOn: boolean;
  /** Whether the microphone may open BEFORE the person asks for it: ahead of a
   *  press while a talk button or a teammate's face is under the pointer, and
   *  muted inside a prewarmed room. Off means a press, an unmute or a record is
   *  the only thing that opens it. On until turned off once. */
  micAutoOpen: boolean;
  /** Whether a start or an answer shows the camera and the microphone first
   *  (components/calls/HuddleStartDialog). On until turned off once. */
  deviceCheck: boolean;
};

function ui(): any {
  return (useInboxStore.getState() as any).clientState?.ui ?? {};
}

export function readJoinPrefs(): JoinPrefs {
  const u = ui();
  return {
    micDeviceId: chosenDevice("audioinput"),
    cameraDeviceId: chosenDevice("videoinput"),
    speakerDeviceId: chosenDevice("audiooutput"),
    cameraOn: u.call_camera_on !== false,
    micOn: u.call_mic_on !== false,
    micAutoOpen: u.call_mic_auto_open !== false,
    deviceCheck: u.call_device_check !== false,
  };
}

// The single device id a machine remembered before rankings existed. Read
// only as the fallback for a kind the person has not ranked yet.
const LEGACY_DEVICE_KEY = {
  audioinput: "call_mic_device_id",
  audiooutput: "call_speaker_device_id",
  videoinput: "call_camera_device_id",
} as const;

/** The device of this kind a join opens now: the best-ranked one plugged in.
 *  Undefined until the browser has listed devices, which means "whatever the
 *  browser picks". */
export function chosenDevice(kind: DeviceKind, devices = knownDevices(kind)): string | undefined {
  const u = ui();
  const legacy = u[LEGACY_DEVICE_KEY[kind]] || undefined;
  if (!devices?.length) return legacy;
  return resolveDevice(u[DEVICE_RANK_KEY[kind]], devices, legacy) || undefined;
}

/** Whether a capture is on the device a join would open now. True while
 *  nothing is chosen, since then any device is the browser's pick. */
export function onChosenDevice(track: MediaStreamTrack, kind: DeviceKind): boolean {
  const want = chosenDevice(kind);
  return !want || trackOnDevice(track, kind, want);
}

/** The person picked a device in a picker: it now outranks every device that
 *  was there to be picked. */
export function rememberDevice(kind: DeviceKind, deviceId: string): void {
  if (!deviceId) return;
  const present = knownDevices(kind) ?? [];
  const picked = present.find((d) => d.deviceId === deviceId);
  if (!picked) return;
  const key = DEVICE_RANK_KEY[kind];
  const rank: string[] = ui()[key] ?? [];
  const next = rankAfterPick(rank, picked, present);
  if (next.length === rank.length && next.every((k, i) => k === rank[i])) return;
  useInboxStore.getState().updateClientUI({ [key]: next } as any);
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

/** The person decided whether the microphone may open ahead of a press. Off is
 *  the answer to "the recording light is on and I pressed nothing". */
export function rememberMicAutoOpen(on: boolean): void {
  if (readJoinPrefs().micAutoOpen === on) return;
  useInboxStore.getState().updateClientUI({ call_mic_auto_open: on });
}

/** The person decided whether a call starts with a look at their camera and
 *  microphone, or goes straight in. */
export function rememberDeviceCheck(on: boolean): void {
  if (readJoinPrefs().deviceCheck === on) return;
  useInboxStore.getState().updateClientUI({ call_device_check: on });
}

// The capture constraints live with the rest of the media options
// (livekitMedia), which a guest's page reads without the store.
export { micConstraints } from "./livekitMedia";
