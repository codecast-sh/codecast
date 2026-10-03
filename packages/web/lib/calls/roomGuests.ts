import { isGuestParticipant } from "@codecast/shared/contracts";
import type { LiveRoomGuest } from "../../store/inboxStore";
import type { GuestMedia } from "./callMedia";
import { firstName } from "../../components/calls/speakers";

// The guests of a room, folded into the roster a member's stage draws.
//
// A member's stage reads its people from the room's seats (call_members), and
// a guest has no seat: they are a call_guests row the room lists apart
// (calls.getLiveRooms `guests`). Without this fold a guest with their camera
// off was nobody on the stage, a voice with no face, and the header's count
// said one fewer person than the room could hear. The fold gives each guest
// the seat's shape, keyed by their LiveKit identity (`guest:<id>`), which is
// the id the speaking ring, the tiles and every name mark already read.

/** A stage roster row: the call_members projection, plus the guest flag. */
export type StageRosterRow = {
  user_id: string;
  user_name?: string;
  user_image?: string;
  muted?: boolean;
  sharing?: boolean;
  joined_at?: number;
  guest?: boolean;
};

/** The room's seats, then its guests in the order they were let in. A guest
 *  is never listed twice, and never in place of a seat. */
export function rosterWithGuests<T extends { user_id: unknown }>(
  seats: readonly T[],
  guests: readonly LiveRoomGuest[] | undefined,
): Array<T | StageRosterRow> {
  if (!guests?.length) return seats as Array<T | StageRosterRow>;
  const seen = new Set(seats.map((m) => String(m.user_id)));
  const extra: StageRosterRow[] = [];
  for (const g of [...guests].sort((a, b) => a.joined_at - b.joined_at || a.identity.localeCompare(b.identity))) {
    if (seen.has(g.identity)) continue;
    seen.add(g.identity);
    extra.push({ user_id: g.identity, user_name: g.name, joined_at: g.joined_at, guest: true });
  }
  return [...seats, ...extra];
}

/** The roster as the media has it: a guest the server lists by their lease
 *  but the media does not have (a reload waiting on a press, a dropped page)
 *  is not drawn as in the call, and a guest it does have wears their real
 *  microphone (a guest has no seat to carry it). `media` null means nobody
 *  can say (not connected, an older voice host): the server's list stands. */
export function withGuestMedia<T extends { user_id: unknown; guest?: boolean; muted?: boolean }>(
  roster: readonly T[],
  media: readonly GuestMedia[] | null,
): T[] {
  if (!media) return roster as T[];
  const by = new Map(media.map((g) => [g.identity, g]));
  const out: T[] = [];
  for (const row of roster) {
    if (!row.guest) {
      out.push(row);
      continue;
    }
    const g = by.get(String(row.user_id));
    if (g) out.push(g.muted === row.muted ? row : { ...row, muted: g.muted });
  }
  return out;
}

/** The guests withGuestMedia leaves out: let in, still holding their place
 *  by their lease, and not in the media yet (answering the browser's prompt,
 *  reading a notice that changed, one press from walking in after a reload).
 *  The stage draws them the way it draws a teammate being rung, so whoever
 *  pressed Admit can see it worked and that the guest is on their way, not
 *  gone. The server stops listing a guest whose place lapsed, and the ghost
 *  goes with it. Nobody when the media cannot say. */
export function guestsJoining<T extends { user_id: unknown; guest?: boolean }>(
  roster: readonly T[],
  media: readonly GuestMedia[] | null,
): T[] {
  if (!media) return [];
  const here = new Set(media.map((g) => g.identity));
  return roster.filter((row) => row.guest && !here.has(String(row.user_id)));
}

/** A signature of a room's guests, for a store subscription that should wake
 *  when somebody is let in, leaves or is renamed, and never on a heartbeat. */
export function guestsSig(guests: readonly LiveRoomGuest[] | undefined): string {
  return (guests ?? []).map((g) => `${g.identity}:${g.name}:${g.joined_at}`).join("|");
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long a new guest link stays open, as the person making it chooses.
 *  The default is the contract's (GUEST_LINK_TTL_MS: a link sent a day ahead
 *  still works at meeting time); the rest bracket it from "this call only"
 *  to "a standing link for a weekly meeting". */
export const GUEST_LINK_TTL_CHOICES = [
  { label: "1 hour", ms: HOUR },
  { label: "1 day", ms: DAY },
  { label: "7 days", ms: 7 * DAY },
  { label: "30 days", ms: 30 * DAY },
] as const;

/** When an open link closes, said the way a person would check it: minutes
 *  while it is about to, a time today, a weekday this week, a date after. */
export function guestLinkExpiry(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "expired";
  if (left < HOUR) return `closes in ${Math.max(1, Math.ceil(left / MIN))} min`;
  const at = new Date(expiresAt);
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (left < 20 * HOUR && at.getDate() === new Date(now).getDate()) return `open until ${time}`;
  if (left < 6 * DAY) return `open until ${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `open until ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

// Is this speaker a guest: the shared test, here for the web's importers.
export { isGuestParticipant };

/** What a meeting is called on the guest's page: the name the inviter could
 *  see (callGuests.linkTitle), else who invited them ("A call with Sam"). */
export function meetingTitle(title: string | null | undefined, inviter: { name: string | null } | null | undefined): string {
  return title?.trim() || (inviter?.name ? `A call with ${firstName(inviter.name)}` : "A codecast call");
}
