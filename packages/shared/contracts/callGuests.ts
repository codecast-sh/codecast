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

import { isAgentFaceIdentity } from "./callRoomKeys";

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
  const clean = Array.from((raw ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim());
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
//   left      walked out (or their lease went stale)
export const CALL_GUEST_STATUSES = ["waiting", "admitted", "denied", "removed", "left"] as const;
export type CallGuestStatus = (typeof CALL_GUEST_STATUSES)[number];

/** Whether a guest may hold a media token right now. */
export function guestMayJoin(status: CallGuestStatus): boolean {
  return status === "admitted";
}

// How long a guest link stays open by default: long enough to send a link a
// day ahead of a meeting, short enough that a forgotten one dies on its own.
export const GUEST_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The web path a guest link opens. `/join/<code>` is taken by team
 *  invites, which make an account; this one never does. */
export function guestJoinPath(token: string): string {
  return `/meet/${token}`;
}
