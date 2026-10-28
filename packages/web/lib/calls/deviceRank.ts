// Which microphone, speaker and camera a call uses, as a RANKING the person
// builds by picking, resolved against whatever is plugged in right now.
//
// A single remembered device id could not hold "my headphones when they are
// on, the Studio Display otherwise": picking the display while the headphones
// were off overwrote the headphones, and the next call with them on opened the
// display. And a device id is salted per origin, so the desktop app and a
// browser tab never agreed on one. So the ranking names devices by their
// label, which is the same in every window on every machine, and a pick moves
// the picked device above every device that was there to be picked, and only
// those: a device that was absent was not passed over, so it keeps its place.
//
// The ranking is about the person (the same headphones are the same headphones
// on the laptop and the desktop), so it is a stamped pref and follows them.
// Devices that one machine lacks simply never match there.

export type DeviceKind = "audioinput" | "audiooutput" | "videoinput";

export const DEVICE_KINDS: DeviceKind[] = ["audioinput", "audiooutput", "videoinput"];

/** The clientState.ui key holding each kind's ranking. */
export const DEVICE_RANK_KEY = {
  audioinput: "call_mic_rank",
  audiooutput: "call_speaker_rank",
  videoinput: "call_camera_rank",
} as const;

// Long enough for every device a person owns; short enough that a ranking
// never grows without bound from devices that come and go.
const MAX_RANK = 16;

type Device = Pick<MediaDeviceInfo, "deviceId" | "label">;

/** What a ranking calls a device. The system default ("default", and Windows'
 *  "communications") is its own entry, meaning "follow the OS"; anything else
 *  is its label, or its id while the browser withholds labels. */
export function deviceKey(d: Device): string {
  if (d.deviceId === "default" || d.deviceId === "communications") return d.deviceId;
  return d.label || `id:${d.deviceId}`;
}

/** The ranking after the person picks `picked` from `present`. */
export function rankAfterPick(rank: string[], picked: Device, present: Device[]): string[] {
  const key = deviceKey(picked);
  const here = new Set(present.map(deviceKey));
  const rest = rank.filter((k) => k !== key);
  const at = rest.findIndex((k) => here.has(k));
  const next = at < 0 ? [...rest, key] : [...rest.slice(0, at), key, ...rest.slice(at)];
  return next.slice(0, MAX_RANK);
}

/** The device to open: the best-ranked one plugged in, else `fallbackId`
 *  when it is plugged in, else the system default, else the first listed.
 *  Empty when nothing is listed. */
export function resolveDevice(rank: string[] | undefined, devices: Device[], fallbackId?: string): string {
  if (devices.length === 0) return "";
  for (const k of rank ?? []) {
    const d = devices.find((d) => deviceKey(d) === k);
    if (d) return d.deviceId;
  }
  if (fallbackId && devices.some((d) => d.deviceId === fallbackId)) return fallbackId;
  return (devices.find((d) => d.deviceId === "default") ?? devices[0]).deviceId;
}

/** Whether a live capture is on this device: by id, or by label where the
 *  browser reports the id another way. */
export function trackOnDevice(track: MediaStreamTrack, kind: DeviceKind, deviceId: string): boolean {
  if (track.getSettings?.().deviceId === deviceId) return true;
  const label = knownDevices(kind)?.find((d) => d.deviceId === deviceId)?.label;
  return !!label && label === track.label;
}

// ── what is plugged in ────────────────────────────────────────────────────
// A join reads its devices synchronously, so the current lists are kept here,
// listed once at load and again whenever a device comes or goes. Listing never
// asks for permission.

const lists: Partial<Record<DeviceKind, Device[]>> = {};
const listeners = new Set<() => void>();
let watching = false;

export function knownDevices(kind: DeviceKind): Device[] | undefined {
  return lists[kind];
}

/** Record a fresh list for one kind (every listing path reports here). */
export function noteDevices(kind: DeviceKind, devices: Device[]): void {
  if (devices.some((d) => d.deviceId)) lists[kind] = devices;
}

export async function refreshDevices(): Promise<void> {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md?.enumerateDevices) return;
  try {
    const all = await md.enumerateDevices();
    for (const kind of DEVICE_KINDS) noteDevices(kind, all.filter((d) => d.kind === kind));
  } catch {}
}

/** Call `fn` after the lists change because a device came or went. */
export function onDevicesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function watch(): void {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (watching || !md?.addEventListener) return;
  watching = true;
  void refreshDevices();
  md.addEventListener("devicechange", () => {
    void refreshDevices().then(() => {
      for (const fn of listeners) fn();
    });
  });
}

watch();
