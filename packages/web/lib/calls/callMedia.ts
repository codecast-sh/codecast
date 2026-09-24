import { Room, type Track, type Participant } from "livekit-client";
import { peekOsPermissions, permissionHint, refreshOsPermissions } from "../osPermissions";

// ── track fan-out to React ────────────────────────────────────────────────
// One tile per VIDEO TRACK, not per participant: a person can have a camera
// and a screen share up at once and both must render, each in its own
// <video>. Keyed by track sid so a tile's identity is the track's identity —
// React never remounts a <video> because a sibling track appeared, and the
// snapshot always hands out a fresh object when a track is (re)published, so
// useSyncExternalStore consumers re-run their attach effects.
export type ParticipantTile = {
  key: string;
  identity: string;
  name: string;
  image?: string;
  isLocal: boolean;
  kind: "camera" | "screen";
  track: Track;
};

// Why did capture fail? livekit resolves null (no throw) when getUserMedia
// yields nothing, and the OS permission state tells the cases apart: a
// denial (System Settings on the desktop, a site setting in a browser)
// versus a machine with no such device. The message is the fix, phrased for
// the person holding the mouse; the notice that shows it carries the fix
// button (`call.errorFix`).
export async function mediaFailureReason(kind: "camera" | "microphone", err?: any): Promise<string> {
  const label = kind === "camera" ? "Camera" : "Microphone";
  if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") {
    return `No ${kind} found`;
  }
  await refreshOsPermissions().catch(() => {});
  const hint = permissionHint(kind, peekOsPermissions()[kind]);
  if (hint) return hint;
  return err?.name === "NotAllowedError" ? `${label} permission denied` : `${label} unavailable`;
}

/**
 * `prompt: false` lists without asking the browser for permission. LiveKit's
 * default asks, which is right inside a call (the device is already open) and
 * wrong in a settings panel, where opening the page must never raise a
 * permission dialog. Without permission Chrome still lists the devices, only
 * without names — DeviceRows offers the one-time grant that names them.
 */
export async function listDevices(kind: MediaDeviceKind, opts?: { prompt?: boolean }): Promise<MediaDeviceInfo[]> {
  try {
    return await Room.getLocalDevices(kind, opts?.prompt !== false);
  } catch {
    return [];
  }
}

/** Ask once for the microphone and camera so `enumerateDevices` can name them,
 *  then release both at once. Nothing is published and nothing stays open. */
export async function grantDeviceNames(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    for (const t of stream.getTracks()) t.stop();
    return true;
  } catch {
    // Video may be the only refusal (no camera); audio alone still names the mics.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of stream.getTracks()) t.stop();
      return true;
    } catch {
      return false;
    }
  }
}

export function participantImage(p: Participant): string | undefined {
  try {
    const meta = p.metadata ? JSON.parse(p.metadata) : null;
    return meta?.image ?? undefined;
  } catch {
    return undefined;
  }
}
