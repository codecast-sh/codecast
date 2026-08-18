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

// A people room holds at most this many members — the same ceiling as a chat
// group thread (chatText.MAX_DM_MEMBERS), because a group thread and the
// huddle of its members are the same room. Nine Convex ids of 32 characters
// plus separators is ~300 characters, hence the key length cap below.
export const MAX_ROOM_MEMBERS = 9;
const MAX_ROOM_KEY_LENGTH = 400;

export type ParsedRoomKey =
  // A member set: sorted, unique user ids, two or more. `dm:` is the historic
  // prefix — a 1:1 and a group of five are the same shape with different
  // counts, so nothing else in the system needs a second "group" kind.
  | { kind: "dm"; users: string[] }
  | { kind: "channel"; channelId: string }
  | { kind: "session"; conversationId: string };

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

// The room a chat channel huddles in. A DM or group thread's identity IS its
// member set, so its huddle is the member-set room — the same room the avatar
// bar's 1:1 ring and the "new huddle" picker reach for the same people. A
// public or private channel has its own standing room. `memberIds` must be
// the FULL roster (viewer included); a DM row whose roster is not known yet
// falls back to the channel room so a chip never points at a wrong key.
export function chatRoomKey(channel: {
  id: string;
  kind?: string | null;
  memberIds?: string[] | null;
}): string {
  if (channel.kind === "dm" && channel.memberIds && channel.memberIds.length >= 2) {
    return dmRoomKey(channel.memberIds);
  }
  return channelRoomKey(channel.id);
}
