// Huddle room-key contract, shared by the Convex control plane (callRooms.ts
// authorizes these), the web client (builds keys for chips/huddle buttons),
// and anything else that needs to name a room. A room is a string key, never
// a row; the full semantics live with the authorizer in convex/callRooms.ts.
import { isPerson } from "../team/memberKind";

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
export const CHANNEL_HUDDLE_WARNING_SIZE = 7;

export function channelHuddleMemberIds(
  kind: string | undefined,
  memberIds: readonly string[] | undefined,
  teammates: readonly ({ _id: string; is_bot?: boolean } | null)[] | undefined,
): string[] | undefined {
  if (kind === "community") return [];
  if (!teammates?.length || ((kind === "private" || kind === "dm") && !memberIds)) return undefined;
  const allowed = kind === "private" || kind === "dm" ? new Set(memberIds) : null;
  return [...new Set(teammates.flatMap((m) => isPerson(m) && (!allowed || allowed.has(String(m._id))) ? [String(m._id)] : []))];
}

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

/** The session a room BELONGS to, when it is a session's own room.
 *
 *  This is the one room with a listener who never takes a seat: its agent.
 *  That makes it the exception to two rules written for rooms full of people
 *  — the transcript feeds it live by default (transcripts.withDefaultRoutes),
 *  and one person in it is a conversation rather than someone waiting for an
 *  answer (autoScribe). Both sides ask here so they cannot disagree about
 *  which rooms those exceptions cover. */
export function sessionRoomConversationId(roomKey: string | null | undefined): string | null {
  if (!roomKey) return null;
  const parsed = parseRoomKey(roomKey);
  return parsed?.kind === "session" ? parsed.conversationId : null;
}

/** Is this key a recording rather than a room? Asked on both sides — the server
 *  to shut every live-call door on it, the client to draw a microphone instead
 *  of a telephone. */
export function isRecRoomKey(roomKey: string | null | undefined): boolean {
  return !!roomKey && parseRoomKey(roomKey)?.kind === "rec";
}

/** The names a call's room points at, as far as the reader is allowed to
 *  know them. Each surface resolves these its own way (the web from its
 *  store, the CLI from the server) and hands them here, so the title rule
 *  itself lives once. */
export type CallPlaceNames = {
  /** The session a session room belongs to. */
  sessionTitle?: string | null;
  /** The people of a people room besides the reader ("Ann, Bo"). */
  peerName?: string | null;
  /** A channel room's name, without the "#". */
  channelName?: string | null;
  /** What a call with no title and no known place is called, when the
   *  surface has a truer word than "Untitled huddle" for it. */
  untitled?: string;
  /** The reader, left out of the people a call is named after: "Huddle
   *  with Cam" to Ann, never "Huddle with Ann, Cam". */
  viewerId?: string | null;
};

/** How many people a call's fallback name lists before it counts the rest. */
const TITLE_PEOPLE_SHOWN = 3;

/** "Huddle with Cam, Bo" from the people who spoke in a call, besides the
 *  reader. A team room's huddle has no place name that tells two of them
 *  apart, and its people do: a column of "Untitled huddle" beside "Call with
 *  Cam" read as though only the DM had anyone in it. First names, as the
 *  history row under the title prints them, and the rest counted. */
function peopleTitle(
  participants: ReadonlyArray<{ id: string; name: string }> | undefined,
  viewerId: string | null | undefined,
): string | null {
  const names = (participants ?? [])
    .filter((p) => !viewerId || String(p.id) !== String(viewerId))
    .map((p) => (p.name ?? "").split("@")[0].trim().split(/\s+/)[0])
    .filter(Boolean);
  if (!names.length) return null;
  const shown = names.slice(0, TITLE_PEOPLE_SHOWN).join(", ");
  const more = names.length - TITLE_PEOPLE_SHOWN;
  return `Huddle with ${shown}${more > 0 ? ` and ${more} more` : ""}`;
}

/** How long a call ran, on every surface that lists it (the web's history
 *  and call page, `cast calls`): `31s` under a minute, `12m`, `1h 14m`, or
 *  `live` while it has no end. One rule, so a call has one length. */
export function callLength(startedAt: number, endedAt: number | null | undefined): string {
  if (!endedAt) return "live";
  const sec = Math.max(1, Math.round((endedAt - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
}

/** What a call is called on every surface that lists it: its own title, else
 *  the place it happened, else the people in it, else a plain word. Never
 *  the room key: a key is an opaque id that tells a person nothing and costs
 *  an agent tokens. */
export function callDisplayTitle(
  call: { title?: string | null; room_key: string; participants?: ReadonlyArray<{ id: string; name: string }> },
  names: CallPlaceNames = {},
): string {
  const title = call.title?.trim();
  if (title) return title;
  const parsed = parseRoomKey(call.room_key);
  if (parsed?.kind === "rec") return "Untitled voice note";
  if (names.peerName) return `Call with ${names.peerName}`;
  if (parsed?.kind === "session" && names.sessionTitle) return `Huddle in ${names.sessionTitle}`;
  if (parsed?.kind === "channel" && names.channelName) return `Huddle in #${names.channelName}`;
  return names.untitled ?? peopleTitle(call.participants, names.viewerId) ?? "Untitled huddle";
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

// An agent's voice in a call: a live model with a Tavus face that joins the
// LiveKit room and talks for the agent (convex/callFace.ts). People join under their
// user id; a face joins under this prefix and the agent's conversation id, so
// a client can tell a face from a person by identity alone.
const AGENT_FACE_PREFIX = "agent:";
export function agentFaceIdentity(conversationId: string): string {
  return `${AGENT_FACE_PREFIX}${conversationId}`;
}
export function isAgentFaceIdentity(identity: string): boolean {
  return identity.startsWith(AGENT_FACE_PREFIX);
}
