import { LocalParticipant, Room, Track, type Participant } from "livekit-client";
import { peekOsPermissions, permissionHint, refreshOsPermissions } from "../osPermissions";
import { callParticipantKind } from "@codecast/shared/contracts";

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

/** Every video track in a room as a tile, the local participant first. Built
 *  here, not in the call manager, because two rooms draw from it: a member's
 *  huddle (callManager) and a guest's (lib/calls/guestRoom), and a tile must
 *  mean the same thing on both. */
export function participantTiles(room: Room): ParticipantTile[] {
  const out: ParticipantTile[] = [];
  const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const p of all) {
    const isLocal = p instanceof LocalParticipant;
    const base = {
      identity: p.identity,
      name: p.name || p.identity,
      image: participantImage(p),
      isLocal,
    };
    for (const [source, kind] of [
      [Track.Source.Camera, "camera"],
      [Track.Source.ScreenShare, "screen"],
    ] as const) {
      const pub = p.getTrackPublication(source);
      // A remote track only renders once subscribed; a local one as soon
      // as it exists. Muted camera tracks stay listed (they render as a
      // frozen/black frame the tile can label) — a mute is not a removal.
      const track = pub && (isLocal || pub.isSubscribed) ? pub.track : null;
      if (!track) continue;
      out.push({ ...base, kind, track, key: `${p.identity}:${kind}:${pub!.trackSid || track.sid || "local"}` });
    }
  }
  return out;
}

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

/** What a participant is doing with their microphone and screen, read off
 *  the media itself: the one reading for every surface that has no server
 *  row to ask (a guest has no seat), on a member's stage and a guest's alike. */
export function participantFlags(p: Participant): { muted: boolean; sharing: boolean } {
  return { muted: !p.isMicrophoneEnabled, sharing: p.isScreenShareEnabled };
}

/** The room's guests as the media sees them: in it, and with the microphone
 *  on or off. A guest's lease says they were let in; this says they can be
 *  heard, which is what a face or a row should draw. */
export type GuestMedia = { identity: string; muted: boolean };

export function guestMediaOf(room: Room | null): GuestMedia[] {
  if (!room) return [];
  const out: GuestMedia[] = [];
  for (const p of room.remoteParticipants.values()) {
    if (callParticipantKind(p.identity) === "guest") out.push({ identity: p.identity, muted: participantFlags(p).muted });
  }
  return out;
}

export function participantImage(p: Participant): string | undefined {
  try {
    const meta = p.metadata ? JSON.parse(p.metadata) : null;
    return meta?.image ?? undefined;
  } catch {
    return undefined;
  }
}
