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

export type ParsedRoomKey =
  | { kind: "dm"; users: [string, string] }
  | { kind: "channel"; channelId: string }
  | { kind: "session"; conversationId: string };

// Ids are opaque strings; the parser enforces shape only — existence and
// authorization are the server's job.
export function parseRoomKey(roomKey: string): ParsedRoomKey | null {
  if (typeof roomKey !== "string" || roomKey.length > 200) return null;
  const parts = roomKey.split(":");
  if (parts[0] === "dm" && parts.length === 3) {
    const [, a, b] = parts;
    if (!a || !b || a === b) return null;
    // Canonical order is part of the key's identity: the swapped form is
    // invalid, not an alias — otherwise one pair could occupy two rooms.
    if (a > b) return null;
    return { kind: "dm", users: [a, b] };
  }
  if (parts[0] === "channel" && parts.length === 2 && parts[1]) {
    return { kind: "channel", channelId: parts[1] };
  }
  if (parts[0] === "session" && parts.length === 2 && parts[1]) {
    return { kind: "session", conversationId: parts[1] };
  }
  return null;
}

export function dmRoomKey(a: string, b: string): string {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

export function channelRoomKey(channelId: string): string {
  return `channel:${channelId}`;
}

export function sessionRoomKey(conversationId: string): string {
  return `session:${conversationId}`;
}
