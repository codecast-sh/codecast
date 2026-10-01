import { normalizeGuestName } from "@codecast/shared/contracts";
import type { DeviceChoice } from "../../../lib/calls/guestRoom";

// What a guest's browser remembers, and nothing else.
//
// The proof of who they are is the secret the server handed back on their
// first knock (callGuests.requestJoin returns it ONCE), kept per link: the
// same browser opening two links is two guests, in two rooms. Their name and
// their devices are kept across links, because a person who typed "Ada" and
// picked their headset once should not do it again for the next meeting.
//
// localStorage, not a cookie: nothing here should ride a request the guest
// did not make, and the page is the only reader.

const CREDS_PREFIX = "codecast:guest:link:";
const NAME_KEY = "codecast:guest:name";
const DEVICES_KEY = "codecast:guest:devices";

export type GuestCreds = { guest_id: string; secret: string };
export type GuestMediaPrefs = DeviceChoice & { mic: boolean; camera: boolean };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage blocked (a strict privacy mode): the page still works for this
    // visit, it just cannot remember the guest across a reload.
    return null;
  }
}

function readJson<T>(key: string, s: Storage | null = store()): T | null {
  try {
    const raw = s?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown, s: Storage | null = store()) {
  try {
    s?.setItem(key, JSON.stringify(value));
  } catch {}
}

export function readCreds(token: string, s: Storage | null = store()): GuestCreds | null {
  const c = readJson<GuestCreds>(CREDS_PREFIX + token, s);
  return c && typeof c.guest_id === "string" && typeof c.secret === "string" && c.secret.length >= 16 ? c : null;
}

export function writeCreds(token: string, creds: GuestCreds, s: Storage | null = store()): void {
  writeJson(CREDS_PREFIX + token, creds, s);
}

/** Forget a guest the server no longer knows (a wrong or stale secret). */
export function clearCreds(token: string, s: Storage | null = store()): void {
  try {
    s?.removeItem(CREDS_PREFIX + token);
  } catch {}
}

export function readName(s: Storage | null = store()): string {
  try {
    return normalizeGuestName(s?.getItem(NAME_KEY)) ?? "";
  } catch {
    return "";
  }
}

export function writeName(name: string, s: Storage | null = store()): void {
  const clean = normalizeGuestName(name);
  try {
    if (clean) s?.setItem(NAME_KEY, clean);
  } catch {}
}

/** Mic on and camera on unless the guest turned one off last time. */
export function readMediaPrefs(s: Storage | null = store()): GuestMediaPrefs {
  const p = readJson<Partial<GuestMediaPrefs>>(DEVICES_KEY, s) ?? {};
  return {
    mic: p.mic !== false,
    camera: p.camera !== false,
    ...(typeof p.micId === "string" ? { micId: p.micId } : {}),
    ...(typeof p.cameraId === "string" ? { cameraId: p.cameraId } : {}),
    ...(typeof p.speakerId === "string" ? { speakerId: p.speakerId } : {}),
  };
}

export function writeMediaPrefs(prefs: GuestMediaPrefs, s: Storage | null = store()): void {
  writeJson(DEVICES_KEY, prefs, s);
}
