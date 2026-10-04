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
import { recordingKeptWords } from "./callRecordings";

const GUEST_PREFIX = "guest:";

export function guestIdentity(guestId: string): string {
  return `${GUEST_PREFIX}${guestId}`;
}

export function isGuestIdentity(identity: string | null | undefined): boolean {
  return typeof identity === "string" && identity.startsWith(GUEST_PREFIX) && identity.length > GUEST_PREFIX.length;
}

/** Is this speaker or participant a guest? By identity when there is one
 *  (`guest:<id>`); a transcript line also carries the room's own marking in
 *  its name ("Ada (guest)", callSpeakerName), which a stored line keeps even
 *  where no identity rides along. The one test, for the web's badge and the
 *  phone's "(guest)" alike, so a guest never passes for a teammate on one. */
export function isGuestParticipant(identity: string | null | undefined, name?: string | null): boolean {
  return isGuestIdentity(identity) || /\(\s*guest\s*\)\s*$/i.test(name ?? "");
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

/** The word a marked participant wears beside their name, and what it means
 *  when someone hovers or listens for it. A teammate wears none. */
export const PARTICIPANT_MARKS = {
  guest: { word: "guest", title: "A guest from outside the team" },
  agent: { word: "agent", title: "An AI agent, not a person" },
} as const;
export type ParticipantMark = (typeof PARTICIPANT_MARKS)[keyof typeof PARTICIPANT_MARKS];

/** Which mark this participant wears, or null for a teammate. The agent test
 *  reads the identity alone; the guest test also reads a stored line's name
 *  (isGuestParticipant), which is all a transcript line may carry. One
 *  answer for the web's badge and the phone's "(guest)" and "(agent)", so a
 *  surface never marks one and forgets the other. */
export function participantMark(identity: string | null | undefined, name?: string | null): ParticipantMark | null {
  if (identity && callParticipantKind(identity) === "agent") return PARTICIPANT_MARKS.agent;
  return isGuestParticipant(identity, name) ? PARTICIPANT_MARKS.guest : null;
}

// LiveKit's own participant kinds (protocol ParticipantInfo.Kind), the two
// that are the room's machinery rather than anybody in it: a recording's
// egress, and the agent worker that dispatches agent faces (codecast-face).
// Both join the media room, publish nothing, and have only an id for a name.
// An agent's face is a STANDARD participant (callParticipantKind "agent").
const LIVEKIT_KIND_EGRESS = 2;
const LIVEKIT_KIND_AGENT = 4;

/** Is a media participant of this LiveKit kind the room's machinery? Every
 *  surface that lists the room from the media rather than from seats (a
 *  guest's page, the phone) leaves these out, by this one test. */
export function isRoomMachineryKind(kind: number | undefined): boolean {
  return kind === LIVEKIT_KIND_EGRESS || kind === LIVEKIT_KIND_AGENT;
}

// The name a guest typed is the only name they have, and it is shown to the
// room, written into transcripts and spoken to agents. So it is cleaned once,
// here: control characters and runs of whitespace go, it is capped, and an
// empty one is refused rather than defaulted (a room admitting "Guest" has no
// idea whom it let in). Markdown's emphasis, code and link marks and the colon
// go too: a transcript line reads `**Name**: words` (formatTranscriptChunk),
// and a name carrying `**: ` could forge a second speaker inside one line of
// what the agents read.
export const GUEST_NAME_MAX = 40;

/** The name a guest may go by, or null when nothing usable was typed. */
export function normalizeGuestName(raw: string | null | undefined): string | null {
  const flat = (raw ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/[*_`[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
// the way an accepted ring is), their page went quiet for longer than a
// blink (GUEST_ADMISSION_LAPSE_MS) and the server put them out rather than
// keep a seat nobody can see ("lapsed"), or they were let in and never came
// into the media before their place was let go ("not_joined": the lobby held
// them for a notice that changed, or a permission prompt, and they did not
// press Join in time). Their page says which, because "you left" to somebody
// who did not, or "you lost connection" to somebody who never connected, is
// a small lie at the end of a meeting.
export const CALL_GUEST_LEFT_REASONS = ["self", "huddle_ended", "lapsed", "not_joined"] as const;
export type CallGuestLeftReason = (typeof CALL_GUEST_LEFT_REASONS)[number];

/** Is this guest at the door or in the room right now? At the door, the
 *  lease a seat has (CALL_MEMBER_STALE_MS): the page beats while it is open,
 *  and a knock from a page that closed drops off the door within one window.
 *  Inside, the admission's own window (GUEST_ADMISSION_LAPSE_MS): a guest in
 *  the media room is still there while their phone holds a background page's
 *  timers, and is seen by the media server's roster besides, so the room's
 *  list does not blink them out between beats. The server ends an admission
 *  that outlives that window, so nobody is listed past it. Only a waiting or
 *  admitted row can be present at all. */
export function isGuestPresent(
  row: { status: CallGuestStatus; last_seen: number },
  now: number,
): boolean {
  if (row.status === "waiting") return now - row.last_seen < CALL_MEMBER_STALE_MS;
  return row.status === "admitted" && now - row.last_seen < GUEST_ADMISSION_LAPSE_MS;
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
// A guest whose place was let go without anybody deciding it ("lapsed" or
// "not_joined": a phone that slept in a pocket, a lobby left open) may walk
// back in without knocking for this long, while the huddle they were let into
// still runs: the room already let them in, and asking it again mid-meeting
// for a blink of the network is noise. Past it, or once that huddle ends,
// they knock like anyone.
export const GUEST_RESUME_MS = 10 * 60_000;
// A guest's media token. LiveKit refreshes a connected participant's token
// by itself, so the lifetime does not end a session (removal does, server
// side); it bounds how long a token copied out of a removed guest's client
// stays good for a reconnect.
export const GUEST_TOKEN_TTL_S = 5 * 60;
// A guest at the door of an empty room is waiting for somebody nobody has
// told: the link's creator gets a push, at most this often per link however
// many arrive (a link anybody can hold must not become a pager), and one push
// names everybody waiting when there is more than one.
export const GUEST_CREATOR_NOTICE_MS = 10 * 60_000;
// And across every link one person made: however many of their links got out,
// their phone hears about waiting guests at most this often. Shorter than a
// link's own window, so a real guest at another room's door minutes later
// still reaches them.
export const GUEST_CREATOR_NOTICE_ANY_LINK_MS = 2 * 60_000;
export const CALL_GUEST_WAITING_PUSH_TYPE = "call_guest_waiting";
// The range a link creator may pick; the default is GUEST_LINK_TTL_MS.
export const GUEST_LINK_MIN_TTL_MS = 10 * 60_000;
export const GUEST_LINK_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// How long a guest link stays open by default: long enough to send a link a
// day ahead of a meeting, short enough that a forgotten one dies on its own.
export const GUEST_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Every reason a link turns a guest away: the link's own three (gone,
 *  turned off, expired), the team's (calls switched off), and the person
 *  whose standing the link lived on (no longer able to invite). */
export type GuestLinkRefusal = "not_found" | "revoked" | "expired" | "unavailable" | "inviter_gone";

/** Why a link refuses by its own fields alone (the first three above), or
 *  null. The one rule for a link's life: the server asks it on every knock
 *  and describe, and the guest's lobby asks it again as its clock passes the
 *  expiry, which writes nothing a query would re-run on. */
export function guestLinkRefusal(
  link: { revoked_at?: number | null; expires_at: number } | null,
  now: number,
): "not_found" | "revoked" | "expired" | null {
  if (!link) return "not_found";
  if (link.revoked_at) return "revoked";
  if (now >= link.expires_at) return "expired";
  return null;
}

/** What a guest is told for each refusal, in words for somebody who has never
 *  heard of codecast and only wants to get into a meeting: what happened, and
 *  what they can do about it. Two parts because the guest page puts the first
 *  in its own heading and only the second under it (a body that repeats its
 *  heading reads as a mistake); everything else says both, as one line
 *  (GUEST_LINK_REFUSAL_TEXT). */
export const GUEST_LINK_REFUSAL_PARTS: Record<GuestLinkRefusal, { what: string; next: string }> = {
  not_found: { what: "This link isn't valid.", next: "Ask whoever sent it for a new one." },
  revoked: { what: "This link was turned off.", next: "Ask whoever sent it for a new one." },
  expired: { what: "This link has expired.", next: "Ask whoever sent it for a new one." },
  unavailable: { what: "This meeting isn't taking guests right now.", next: "Try the link again later." },
  inviter_gone: {
    what: "Whoever sent this link can no longer invite guests to this meeting.",
    next: "Ask someone else in it for a new one.",
  },
};

/** The whole refusal as one line. The server throws these from a knock, the
 *  link's unfurl carries them, and the guest page words the same door from the
 *  same parts, so no two places word it differently. */
export const GUEST_LINK_REFUSAL_TEXT = Object.fromEntries(
  Object.entries(GUEST_LINK_REFUSAL_PARTS).map(([k, p]) => [k, `${p.what} ${p.next}`]),
) as Record<GuestLinkRefusal, string>;

/** Why an admitted guest's page may not join the media right now
 *  (callGuests.mintGuestToken). Carried as a ConvexError code because the
 *  page acts on the code, not on words: the ones that end the visit move it
 *  to the matching ending instead of an error line under a Join button. The
 *  other guest refusals (a knock, an admission) are only ever shown, so they
 *  stay plain Errors whose words reach the page as they are. */
export type GuestJoinRefusal = "not_a_guest" | "not_admitted" | "removed" | "ended" | "unavailable";

export const GUEST_JOIN_REFUSAL_TEXT: Record<GuestJoinRefusal, string> = {
  not_a_guest: "This page no longer holds your place in the call. Reload to ask to join again.",
  not_admitted: "You aren't let in right now. Ask to join again and someone inside can let you in.",
  removed: "Someone in the call removed you.",
  ended: "This call has ended.",
  unavailable: GUEST_LINK_REFUSAL_TEXT.unavailable,
};

/** The refusal code a thrown join error carries, or null for anything else
 *  (a network failure, LiveKit itself). */
export function guestJoinRefusalOf(err: unknown): GuestJoinRefusal | null {
  const code = (err as any)?.data?.code;
  return typeof code === "string" && code in GUEST_JOIN_REFUSAL_TEXT ? (code as GuestJoinRefusal) : null;
}

/** What is kept of a call, as a guest is told it. `video_public`: the
 *  recording running will be on the call's public link (convex
 *  callRecordings: a link whose video was chosen before this press), so their
 *  face reaches anyone holding that link, not only the team. */
export type GuestNotice = { recording: boolean; transcribed: boolean; video_public?: boolean };

/**
 * The words a guest's consent rests on: whether what they say is written down
 * and whether their face is on file. One home, because the link's unfurl, the
 * lobby, the door, the call's bar and its mid-call line all say it, and a
 * notice worded five ways drifts until one of them says less than the truth.
 *   long      the lobby and the door: the whole of it, once, before joining
 *   short     a line that must fit beside a face or in a card
 *   label     the pill in the call's bar, one or two words
 * Recording first: it is the larger thing to agree to.
 */
export function guestNoticeLines(
  n: GuestNotice,
  form: "long" | "short" | "label",
): Array<{ key: "rec" | "words"; text: string }> {
  const out: Array<{ key: "rec" | "words"; text: string }> = [];
  if (n.recording) {
    out.push({
      key: "rec",
      text: n.video_public
        ? form === "long"
          ? "This call is being recorded, video and screen shares included, and the video is shared by the call's public link: anyone with that link can watch it. Anyone in the call can stop it."
          : form === "short"
            ? "This call is being recorded, and the video is shared by public link. Anyone in it can stop it."
            : "recording, public"
        : form === "long"
          ? `This call is being recorded, video and screen shares included. ${recordingKeptWords()} Anyone in the call can stop it.`
          : form === "short"
            ? "This call is being recorded, video and screen shares included. Anyone in it can stop it."
            : "recording",
    });
  }
  if (n.transcribed) {
    out.push({
      key: "words",
      text:
        form === "long"
          ? "This call is transcribed. What everyone says is written down for the team, and the AI agents they work with can read it."
          : form === "short"
            ? "This call is transcribed: what everyone says is written down."
            : "transcribed",
    });
  }
  return out;
}

/** What the room keeps now beyond the notice a guest agreed to (`since`),
 *  row by row: `rec` a recording they were not told of, or one whose video
 *  went to the public link since; `words` a transcript switched on. Nothing
 *  is news before they agreed to anything. The one comparison behind the
 *  lobby's "Join, recorded", the rows marked new and the line said inside
 *  the call, so no two of them disagree about what changed. */
export function noticeNews(since: GuestNotice | null | undefined, now: GuestNotice): { rec: boolean; words: boolean } {
  if (!since) return { rec: false, words: false };
  return {
    rec: now.recording && (!since.recording || (!!now.video_public && !since.video_public)),
    words: now.transcribed && !since.transcribed,
  };
}

/** Does the room keep more than the guest agreed to? (noticeNews, any row) */
export function noticeWidened(since: GuestNotice | null | undefined, now: GuestNotice): boolean {
  const n = noticeNews(since, now);
  return n.rec || n.words;
}

/** The notice as one sentence, for a link's card: "This call is recorded and
 *  transcribed.", or "" when nothing is kept. */
export function guestNoticeSentence(n: GuestNotice): string {
  const kept = [n.recording && "recorded", n.transcribed && "transcribed"].filter(Boolean);
  return kept.length ? `This call is ${kept.join(" and ")}.` : "";
}

/** The web path a guest link opens. `/join/<code>` is taken by team
 *  invites, which make an account; this one never does. */
export function guestJoinPath(token: string): string {
  return `/meet/${token}`;
}
