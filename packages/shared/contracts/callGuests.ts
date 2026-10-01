// Guests: people from outside the team who join a huddle from a link.
//
// A guest has no codecast account and never becomes one by joining. They are
// a `call_guests` row, created through a `call_guest_links` link someone in
// the room shared, and they prove they are that row with a secret their
// browser keeps (only its hash is stored). They knock; somebody inside admits
// them; LiveKit then sees them under `guest:<call_guests id>` with the name
// they typed.
//
// The identity prefix is what every surface reads, because the media server
// hands a client nothing else about a participant it can trust: people join
// as their user id, agent faces as `agent:<conversation>` (agentFaceIdentity),
// and guests as `guest:<id>`. So "is this a guest" is a question about the
// identity string alone, answered here once for web, mobile, the scribe and
// Convex. A guest is never an agent and never a teammate, and nothing that
// looks up a user by identity may be handed one (a `guest:` identity is not a
// users id, and db.get on it would throw).

import { CALL_MEMBER_STALE_MS, isAgentFaceIdentity } from "./callRoomKeys";

const GUEST_PREFIX = "guest:";

export function guestIdentity(guestId: string): string {
  return `${GUEST_PREFIX}${guestId}`;
}

export function isGuestIdentity(identity: string | null | undefined): boolean {
  return typeof identity === "string" && identity.startsWith(GUEST_PREFIX) && identity.length > GUEST_PREFIX.length;
}

/** The call_guests id inside a guest identity, or null for anyone else. */
export function guestIdFromIdentity(identity: string | null | undefined): string | null {
  return isGuestIdentity(identity) ? identity!.slice(GUEST_PREFIX.length) : null;
}

export type CallParticipantKind = "person" | "guest" | "agent";

/** Who a LiveKit identity is: a teammate (their user id), a guest, or an
 *  agent's face. The one classifier, so no surface decides it by its own
 *  prefix test. */
export function callParticipantKind(identity: string): CallParticipantKind {
  if (isGuestIdentity(identity)) return "guest";
  if (isAgentFaceIdentity(identity)) return "agent";
  return "person";
}

// The name a guest typed is the only name they have, and it is shown to the
// room, written into transcripts and spoken to agents. So it is cleaned once,
// here: control characters and runs of whitespace go, it is capped, and an
// empty one is refused rather than defaulted (a room admitting "Guest" has no
// idea whom it let in).
export const GUEST_NAME_MAX = 40;

/** The name a guest may go by, or null when nothing usable was typed. */
export function normalizeGuestName(raw: string | null | undefined): string | null {
  const flat = (raw ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  // The "(guest)" marking is the room's to add (guestDisplayName), never the
  // guest's: typed in, it would read "Sam (guest) (guest)" everywhere.
  const clean = Array.from(flat.replace(/(?:\s*\(\s*guest\s*\))+$/i, "").trim());
  if (clean.length === 0) return null;
  return clean.slice(0, GUEST_NAME_MAX).join("").trim();
}

/** How a guest reads wherever the room lists people: their name, marked as
 *  a guest so nobody mistakes them for a teammate. Faces and chips that have
 *  a badge of their own show the plain name beside it instead. */
export function guestDisplayName(name: string | null | undefined): string {
  return `${normalizeGuestName(name) ?? "Guest"} (guest)`;
}

/** The speaker name a transcript line carries for a participant: a guest is
 *  marked in the words themselves, because a transcript outlives the call and
 *  is read where no badge can follow (a session, a doc, a Slack channel). */
export function callSpeakerName(identity: string, name: string | null | undefined): string {
  if (isGuestIdentity(identity)) return guestDisplayName(name);
  return (name ?? "").trim() || "Someone";
}

// A guest's lifecycle, on their own row (the knock and the seat are one row:
// a guest has no user to hang a call_knocks or call_members row on):
//   waiting   at the door; the room is asked to admit or deny
//   admitted  let in; may mint a media token while the link and row live
//   denied    turned away at the door
//   removed   put out of the call by somebody inside it
//   left      walked out, the huddle ended, or their page went quiet
//             (left_reason says which)
export const CALL_GUEST_STATUSES = ["waiting", "admitted", "denied", "removed", "left"] as const;
export type CallGuestStatus = (typeof CALL_GUEST_STATUSES)[number];

/** Whether a guest may hold a media token right now. */
export function guestMayJoin(status: CallGuestStatus): boolean {
  return status === "admitted";
}

// Why an admitted or waiting guest is now `left`: they walked out, the
// huddle they were let into ended under them (an admission is for one huddle,
// the way an accepted ring is), or their page went quiet for longer than a
// blink (GUEST_ADMISSION_LAPSE_MS) and the server put them out rather than
// keep a seat nobody can see. Their page says which, because "you left" to
// somebody who did not is a small lie at the end of a meeting.
export const CALL_GUEST_LEFT_REASONS = ["self", "huddle_ended", "lapsed"] as const;
export type CallGuestLeftReason = (typeof CALL_GUEST_LEFT_REASONS)[number];

/** Is this guest at the door or in the room right now? The same lease a seat
 *  has (CALL_MEMBER_STALE_MS): the guest's page beats while it is open, and a
 *  page that closed without saying so reads as gone within one window. Only a
 *  waiting or admitted row can be present at all. */
export function isGuestPresent(
  row: { status: CallGuestStatus; last_seen: number },
  now: number,
): boolean {
  return (row.status === "waiting" || row.status === "admitted") && now - row.last_seen < CALL_MEMBER_STALE_MS;
}

// What the guest's own page shows, one word per screen it can be on. The
// stored status plus what only the server can see: whether the huddle they
// were admitted to is still running, and whether the link they are waiting
// on was turned off.
//   waiting   at the door; the room has been asked
//   admitted  in (or may connect)
//   denied    turned away; may ask again after a minute
//   removed   put out by somebody inside; this row cannot come back
//   left      they walked out
//   ended     the huddle they were in is over
//   closed    the link expired or was turned off while they waited
export type CallGuestView = "waiting" | "admitted" | "denied" | "removed" | "left" | "ended" | "closed";

// Abuse limits on a link anybody can hold. A link is a door, not a queue: a
// handful of new people a minute is a meeting starting, more is somebody
// scripting it. A room shows at most this many strangers waiting at once, and
// holds at most MAX_ROOM_GUESTS admitted, so a leaked link cannot fill a call.
// One link holds at most MAX_WAITING_PER_LINK of the room's waiting places,
// so a link that leaked cannot keep out the guests arriving on another.
export const GUEST_KNOCKS_PER_LINK_PER_MINUTE = 6;
export const MAX_WAITING_GUESTS = 8;
export const MAX_WAITING_PER_LINK = 4;
export const MAX_ROOM_GUESTS = 8;
// A turned-away guest may ask again after this long, the same quiet minute a
// declined ring buys its recipient.
export const GUEST_DENY_COOLDOWN_MS = 60_000;
// A re-knock refreshes the room's view of the knock no more often than this,
// so a page left knocking (or a script) cannot make the door flicker.
export const GUEST_REKNOCK_MIN_MS = 10_000;
// An admitted guest whose page has not beaten for this long is gone, not
// blinking: the server marks them left ("lapsed") and puts them out of the
// media room, so a client that keeps the media open and stops beating cannot
// sit in the call unseen. Twice a seat's lease, so a slow network is not
// mistaken for a departure.
export const GUEST_ADMISSION_LAPSE_MS = 2 * CALL_MEMBER_STALE_MS;
// A guest's media token. LiveKit refreshes a connected participant's token
// by itself, so the lifetime does not end a session (removal does, server
// side); it bounds how long a token copied out of a removed guest's client
// stays good for a reconnect.
export const GUEST_TOKEN_TTL_S = 5 * 60;
// A guest at the door of an empty room is waiting for somebody nobody has
// told: the link's creator gets one push per arrival, at most this often.
export const GUEST_CREATOR_NOTICE_MS = 10 * 60_000;
export const CALL_GUEST_WAITING_PUSH_TYPE = "call_guest_waiting";
// The range a link creator may pick; the default is GUEST_LINK_TTL_MS.
export const GUEST_LINK_MIN_TTL_MS = 10 * 60_000;
export const GUEST_LINK_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// How long a guest link stays open by default: long enough to send a link a
// day ahead of a meeting, short enough that a forgotten one dies on its own.
export const GUEST_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The web path a guest link opens. `/join/<code>` is taken by team
 *  invites, which make an account; this one never does. */
export function guestJoinPath(token: string): string {
  return `/meet/${token}`;
}
