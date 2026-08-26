// Huddle room-key contract, shared by the Convex control plane (callRooms.ts
// authorizes these), the web client (builds keys for chips/huddle buttons),
// and anything else that needs to name a room. A room is a string key, never
// a row; the full semantics live with the authorizer in convex/callRooms.ts.

// Lease timings. The dock heartbeats every CALL_HEARTBEAT_MS while connected;
// readers ignore call_members rows older than CALL_MEMBER_STALE_MS (three
// missed beats plus slack); a ring neither answered nor cancelled within
// CALL_INVITE_TTL_MS reads as expired everywhere.
export const CALL_HEARTBEAT_MS = 15_000;
export const CALL_MEMBER_STALE_MS = 45_000;
export const CALL_INVITE_TTL_MS = 45_000;
// A knock at a locked room: the same 45s as a ring, and for the same reason —
// it is a live gesture, not a queued request. Whoever is inside sees it while
// the knocker is still standing there, or not at all.
export const CALL_KNOCK_TTL_MS = 45_000;

// A people room holds at most as many members as a chat group thread,
// because a group thread and the huddle of its members are the same room.
// Nine Convex ids of 32 characters plus separators is ~300 characters, hence
// the key length cap below.
import { MAX_DM_MEMBERS } from "../chat/dm";
export const MAX_ROOM_MEMBERS = MAX_DM_MEMBERS;
const MAX_ROOM_KEY_LENGTH = 400;

export type ParsedRoomKey =
  // A member set: sorted, unique user ids, two or more. `dm:` is the historic
  // prefix — a 1:1 and a group of five are the same shape with different
  // counts, so nothing else in the system needs a second "group" kind.
  | { kind: "dm"; users: string[] }
  | { kind: "channel"; channelId: string }
  | { kind: "session"; conversationId: string }
  // A recording: one person's microphone, not a room anybody can walk into.
  // The key names a uuid the recorder minted and nothing else — it carries no
  // owner, so who may reach it is answered by the transcript row it started
  // (callRooms authorizeRoomMembership). It is a room key only because the
  // whole transcription pipeline — the ASR mint, segments, flush beats,
  // summaries, the calls page — is keyed by one, and reusing that is the
  // entire design.
  | { kind: "rec"; recId: string };

// A recording id is a uuid this client generated. The parser bounds the shape
// so a key cannot smuggle separators or arbitrary length past it; who owns the
// recording is the server's question, never the key's.
const REC_ID = /^[A-Za-z0-9-]{8,64}$/;

// Ids are opaque strings; the parser enforces shape only — existence and
// authorization are the server's job.
export function parseRoomKey(roomKey: string): ParsedRoomKey | null {
  if (typeof roomKey !== "string" || roomKey.length > MAX_ROOM_KEY_LENGTH) return null;
  const parts = roomKey.split(":");
  if (parts[0] === "dm" && parts.length >= 3 && parts.length <= MAX_ROOM_MEMBERS + 1) {
    const users = parts.slice(1);
    // Canonical order is part of the key's identity: a swapped or repeated
    // form is invalid, not an alias — otherwise one set of people could
    // occupy two rooms.
    for (let i = 0; i < users.length; i++) {
      if (!users[i]) return null;
      if (i > 0 && !(users[i - 1] < users[i])) return null;
    }
    return { kind: "dm", users };
  }
  if (parts[0] === "channel" && parts.length === 2 && parts[1]) {
    return { kind: "channel", channelId: parts[1] };
  }
  if (parts[0] === "session" && parts.length === 2 && parts[1]) {
    return { kind: "session", conversationId: parts[1] };
  }
  if (parts[0] === "rec" && parts.length === 2 && REC_ID.test(parts[1])) {
    return { kind: "rec", recId: parts[1] };
  }
  return null;
}

// The room of a set of people. Order and duplicates do not matter to the
// caller — the key is canonical (sorted, unique) so every side derives the
// identical key without coordination. Two arguments is the 1:1 form.
export function dmRoomKey(...ids: Array<string | string[]>): string {
  return `dm:${roomMemberIds(ids.flat()).join(":")}`;
}

// Sorted unique ids for a people room; the same normalization the parser
// enforces, exposed so a caller can compare member sets without a key.
export function roomMemberIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map(String))).sort();
}

export function channelRoomKey(channelId: string): string {
  return `channel:${channelId}`;
}

export function sessionRoomKey(conversationId: string): string {
  return `session:${conversationId}`;
}

/** The key a recording runs under. The caller mints the id (crypto.randomUUID)
 *  and starts a transcript on it; that transcript is what makes the key theirs. */
export function recRoomKey(recId: string): string {
  return `rec:${recId}`;
}

/** Is this key a recording rather than a room? Asked on both sides — the server
 *  to shut every live-call door on it, the client to draw a microphone instead
 *  of a telephone. */
export function isRecRoomKey(roomKey: string | null | undefined): boolean {
  return !!roomKey && parseRoomKey(roomKey)?.kind === "rec";
}

// The room a chat channel huddles in. A DM or group thread's identity IS its
// member set, so its huddle is the member-set room — the same room the avatar
// bar's 1:1 ring and the "new huddle" picker reach for the same people. A
// public or private channel has its own standing room.
//
// The roster comes in either form and this function owns the merge — every
// client passes what it has and gets the same key: `memberIds` is the FULL
// roster (viewer included); `otherIds` + `viewerId` is the "everyone but me"
// shape the rails carry (dm_key derived). A DM row whose roster is not known
// yet falls back to the channel room so a chip never points at a wrong key.
//
// `teammateIds` (the caller's current team roster) makes the fallback
// roster-aware: a group thread whose member LEFT the team keeps a stale
// dm_key naming them, and the member-set room would be refused server-side
// ("no shared team") on every surface forever. Such a thread huddles in its
// channel room instead — still one convergent key, and one the remaining
// members are allowed to open.
export function chatRoomKey(channel: {
  id: string;
  kind?: string | null;
  memberIds?: string[] | null;
  otherIds?: string[] | null;
  viewerId?: string | null;
  teammateIds?: string[] | null;
}): string {
  if (channel.kind === "dm") {
    const roster =
      channel.memberIds && channel.memberIds.length >= 2
        ? channel.memberIds
        : channel.viewerId && channel.otherIds?.length
          ? [channel.viewerId, ...channel.otherIds]
          : null;
    if (roster) {
      if (channel.teammateIds) {
        const team = new Set(channel.teammateIds.map(String));
        team.add(String(channel.viewerId ?? ""));
        if (roster.some((id) => !team.has(String(id)))) {
          return channelRoomKey(channel.id);
        }
      }
      return dmRoomKey(roster);
    }
  }
  return channelRoomKey(channel.id);
}
