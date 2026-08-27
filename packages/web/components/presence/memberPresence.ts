// Pure display logic for person presence (teams.getTeamMembers extensions):
// state → badge/avatar styling, the activity line every surface leads with, and
// the fleet counts derived from sessions already in the store. Kept React-free
// so it's unit-testable under bun, mirroring fleetBands.ts. The React half is
// PresenceBadge.tsx, which paints what this module decides.
import { type InboxSession } from "../../store/inboxStore";
import { fleetBandFor, type FleetBandOpts } from "../fleetBands";
import { memberDisplayName as liveMemberDisplayName } from "../../lib/liveEntities";

export type PresenceState = "active" | "idle" | "away" | "offline";
/** What a badge draws. "busy" is the manual status, not a heartbeat state. */
export type PresenceVisual = PresenceState | "busy";

// Shape + color + word, never hue alone: the old encoding was a green ring for
// active and 50% opacity for away, which is one channel (hue) in the palette's
// lowest-contrast accent and unreadable at 8px. Every state now differs in
// FILL (solid, hollow, glyph, absent) before it differs in color, and carries a
// label the surfaces print.
export const PRESENCE_META: Record<
  PresenceVisual,
  {
    /** The bare word, for a chip or a title attribute. */
    label: string;
    /** presence.css class the badge takes on top of .pres. */
    badge: string;
    /** Tailwind text color for the activity line and the state's own words. */
    text: string;
    /** presence.css class for the avatar treatment; "" leaves it untouched. */
    avatar: string;
    /** Drawn inside the badge. "" is a plain disc or ring. */
    glyph: "" | "moon" | "minus";
  }
> = {
  active: { label: "Active", badge: "pres-active", text: "text-sol-cyan", avatar: "", glyph: "" },
  idle: { label: "Idle", badge: "pres-idle", text: "text-sol-yellow", avatar: "", glyph: "" },
  away: { label: "Away", badge: "pres-away", text: "text-sol-text-muted", avatar: "pres-av-away", glyph: "moon" },
  offline: { label: "Offline", badge: "", text: "text-sol-text-dim", avatar: "pres-av-offline", glyph: "" },
  busy: { label: "Busy", badge: "pres-busy", text: "text-sol-red", avatar: "", glyph: "minus" },
};

export function memberPresenceState(member: any): PresenceState {
  const s = member?.presence_state;
  return s === "active" || s === "idle" || s === "away" ? s : "offline";
}

/** What to DRAW for a member: the heartbeat state, overridden by what they
 *  DECLARED (`busy`, `away`). A declaration is the stronger fact — the point of
 *  setting one is that teammates see it — and it governs the words too, so the
 *  badge and the line can never disagree.
 *
 *  Offline wins over both: a machine that stopped reporting is not busy, it is
 *  gone, and a stale do-not-disturb flag must not claim otherwise.
 *
 *  A LIVE ROOM IS ITSELF A REPORT, and it is the one thing that outranks the
 *  heartbeat. `in_huddle` and `in_room_key` come from call_members and carry
 *  their own lease, so somebody sitting in a room is demonstrably here — their
 *  media is flowing — whatever their keyboard has been doing. Presence is
 *  driven by INPUT, and listening in a huddle is not input: past
 *  INPUT_ACTIVE_MS (3 min) everyone in a long call turned idle, and past 20
 *  minutes away. A teammate could be talking to you while their row read
 *  "Away" and their face was greyed out, with the activity line beside it
 *  saying "in a huddle with you".
 *
 *  It does not override a DECLARATION. Busy is still busy, and an away
 *  somebody set for themselves is still theirs to have set. */
export function memberPresenceVisual(member: any): PresenceVisual {
  const state = memberPresenceState(member);
  const inRoom = !!(member?.in_huddle || member?.in_room_key);
  if (state === "offline" && !inRoom) return "offline";
  if (member?.status === "busy") return "busy";
  if (member?.status === "away") return "away";
  return inRoom ? "active" : state;
}

/** The name a surface prints for a member. One helper so the strip, the roster
 *  and the card cannot disagree about what a person is called — and it is the
 *  app's ONE rule, not a second one, because that promise was already broken:
 *  this file used to answer with the local part of an email while
 *  `lib/liveEntities` answered with the github handle, and both were live. The
 *  people window and the avatar bar read this; the walkie strip, the ring and
 *  chat read that. Same person, two names. It now delegates. */
export function memberDisplayName(member: any): string {
  return liveMemberDisplayName(member);
}

/** The bare word for a state — for chips, titles and legends. */
export function presenceLabel(state: PresenceVisual): string {
  return PRESENCE_META[state].label;
}

/** The avatar treatment that goes with a presence state (grayscale/opacity).
 *  One helper so the strip, the hover card and the roster fade a face the same
 *  way instead of each inventing an opacity. */
export function presenceAvatarClass(state: PresenceVisual): string {
  return PRESENCE_META[state].avatar;
}

/** The roster's sections, in the order a buddy list shows them. Busy sits under
 *  Online: they are at the machine and reachable, and the badge already says
 *  not now. A DECLARED away sorts under Away even on a live heartbeat, because
 *  that is what they said. */
export type PresenceBand = "online" | "idle" | "away" | "offline";

export const PRESENCE_BAND_LABEL: Record<PresenceBand, string> = {
  online: "Online",
  idle: "Idle",
  away: "Away",
  offline: "Offline",
};

const BAND_OF: Record<PresenceVisual, PresenceBand> = {
  active: "online",
  busy: "online",
  idle: "idle",
  away: "away",
  offline: "offline",
};

export function presenceBand(member: any): PresenceBand {
  return BAND_OF[memberPresenceVisual(member)];
}

const BAND_ORDER: PresenceBand[] = ["online", "idle", "away", "offline"];

/** The roster, cut into its sections. Empty sections are dropped, so a team
 *  where nobody is idle shows no Idle heading. Within a section the order is
 *  by name and NOTHING else — a roster that reshuffled on every heartbeat
 *  would be unusable as a list of people you click. */
export function groupMembersByBand<T>(
  members: T[],
): { band: PresenceBand; label: string; members: T[] }[] {
  const buckets = new Map<PresenceBand, T[]>();
  for (const m of members) {
    if (!m) continue;
    const band = presenceBand(m);
    const bucket = buckets.get(band);
    if (bucket) bucket.push(m);
    else buckets.set(band, [m]);
  }
  const out: { band: PresenceBand; label: string; members: T[] }[] = [];
  for (const band of BAND_ORDER) {
    const rows = buckets.get(band);
    if (!rows?.length) continue;
    rows.sort((a: any, b: any) =>
      (a.name || a.email || "").localeCompare(b.name || b.email || ""),
    );
    out.push({ band, label: PRESENCE_BAND_LABEL[band], members: rows });
  }
  return out;
}

const PRESENCE_ORDER: Record<PresenceState, number> = {
  active: 0,
  idle: 1,
  away: 2,
  offline: 3,
};

// Stable roster order: presence band, then name — deliberately NOT freshness
// within a band, so rows don't swap on every heartbeat.
export function compareMembersByPresence(a: any, b: any): number {
  const pa = PRESENCE_ORDER[memberPresenceState(a)];
  const pb = PRESENCE_ORDER[memberPresenceState(b)];
  if (pa !== pb) return pa - pb;
  return (a.name || a.email || "").localeCompare(b.name || b.email || "");
}

function compactDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// The hover card's one presence sentence. `now` must be a coarse clock
// (useCoarseNow), never Date.now() in render.
export function presenceLine(member: any, now: number): string {
  const state = memberPresenceVisual(member);
  if (state === "busy") return "Busy";
  if (state === "active") return "Active now";
  if (state === "idle") {
    const at = member.presence_input_at;
    return typeof at === "number"
      ? `Idle ${compactDuration(now - at)}`
      : "Idle";
  }
  if (state === "away") return "Away";
  const seen = member.daemon_last_seen;
  return typeof seen === "number"
    ? `Last seen ${compactDuration(now - seen)} ago`
    : "Offline";
}

// A teammate's local wall-clock, from their profile timezone. Empty when the
// timezone is missing/invalid or matches the viewer's (no news there).
export function localTimeLine(timezone: string | undefined, now: number): string {
  if (!timezone) return "";
  try {
    if (timezone === Intl.DateTimeFormat().resolvedOptions().timeZone) return "";
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }).format(now);
  } catch {
    return "";
  }
}

export interface FleetSummary {
  working: number;
  needsYou: number;
  /** thread_state_status of the most actionable session, for the quote line. */
  topStatus: string | null;
  /** Its title, for the activity line's "· fixing auth" tail. */
  topTitle: string | null;
  topSessionKey: string | null;
}

// "3 working · 1 needs input" for one member — the server sends no fleet
// counts, so these are derived client-side. Callers must hand in the
// inbox-VISIBLE rows (fleetCountedSessions), never the raw session cache: the
// cache holds 30 days of rows plus everything the user set aside, and counting
// it raw produced numbers that matched no surface the viewer could see. A
// member with no visible sessions gets no summary, and the card omits the line.
export function memberFleetSummary(
  sessions: InboxSession[],
  memberId: string,
  opts: FleetBandOpts,
): FleetSummary | null {
  const mine = sessions.filter((s) => s && String(s.user_id ?? "") === memberId);
  return mine.length ? fleetSummariesByMember(mine, opts).get(memberId) ?? null : null;
}

/** The same counts for EVERY member in one pass. A roster of twenty faces asks
 *  this once at the list, instead of walking the whole session cache per row. */
export function fleetSummariesByMember(
  sessions: InboxSession[],
  opts: FleetBandOpts,
): Map<string, FleetSummary> {
  const out = new Map<string, FleetSummary>();
  for (const s of sessions) {
    const uid = s ? String(s.user_id ?? "") : "";
    if (!uid) continue;
    let f = out.get(uid);
    if (!f) {
      f = { working: 0, needsYou: 0, topStatus: null, topTitle: null, topSessionKey: null };
      out.set(uid, f);
    }
    const band = fleetBandFor(s, opts);
    if (band === "running") f.working++;
    else if (band === "needsYou") f.needsYou++;
    // Quote the most actionable live status line: prefer a needsYou session's,
    // else any running one's.
    const status = (s as any).thread_state_status;
    if (status && (band === "needsYou" || (band === "running" && !f.topStatus))) {
      f.topStatus = status;
      f.topSessionKey = (s as any).session_id ?? s._id;
    }
    // The title follows the same band preference but needs no status line:
    // "2 agents working · fixing auth" is the point of it.
    if (band === "needsYou" || (band === "running" && !f.topTitle)) {
      const title = (s.title ?? "").trim();
      if (title) f.topTitle = title;
    }
  }
  return out;
}

export function fleetLine(f: FleetSummary): string {
  const parts: string[] = [];
  if (f.working) parts.push(`${f.working} working`);
  if (f.needsYou) parts.push(`${f.needsYou} need${f.needsYou === 1 ? "s" : ""} input`);
  return parts.join(" · ");
}

export interface PresenceActivityCtx {
  /** Coarse clock (useCoarseNow), never Date.now() in render. */
  now: number;
  /** The member's fleet, from memberFleetSummary. */
  fleet?: FleetSummary | null;
  /** The huddle this member is sitting in, when the viewer can see it at all
   *  (useLiveRoomOfMember). A locked room the viewer may not enter still
   *  arrives here, and says so. `roomKey` and `members` let a people room be
   *  named from THIS member's seat instead of the viewer's — see huddleLine. */
  room?: {
    label?: string;
    locked?: boolean;
    roomKey?: string;
    members?: { user_id: string; user_name?: string }[];
  } | null;
  /** The viewer, so a huddle they are in can say "with you" instead of
   *  reading them their own name. */
  viewerId?: string;
  /** The viewer is hearing this member on the walkie right now. */
  talking?: boolean;
}

const CAP = (n: number) => (n > 20 ? "20+" : String(n));
const agents = (n: number) => `${CAP(n)} agent${n === 1 ? "" : "s"}`;

/** "Ann", "Ann and Bo", "Ann, Bo and 3 more" — a roster row has one line and
 *  a crowd must not push the rest of it off the end. */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * Naming the huddle a person is sitting in, on a row that is ABOUT that person.
 *
 * `room.label` names a room from the VIEWER's seat — right for the dock pill of
 * the room they are in, wrong here. A DM huddle between Riley and the viewer
 * labels as "Riley Chen", and printed on Riley's row it said his name twice:
 * "in a huddle · Riley Chen". The row already carries the name; the useful half
 * is the OTHER end.
 *
 * So a people room is re-named from the row's own seat, and the viewer appears
 * as "you" rather than as their own name. Channel and session rooms keep the
 * shared label: "#design" names no one and reads correctly on every surface.
 */
function huddleLine(member: any, ctx: PresenceActivityCtx): string {
  const room = ctx.room;
  const roster = room?.members;
  const isPeopleRoom = String(room?.roomKey ?? "").startsWith("dm:");

  if (isPeopleRoom && roster) {
    const memberId = String(member?._id ?? "");
    const viewerId = String(ctx.viewerId ?? "");
    const others = roster.filter((m) => String(m.user_id) !== memberId);
    const withViewer = !!viewerId && others.some((m) => String(m.user_id) === viewerId);
    const rest = others
      .filter((m) => String(m.user_id) !== viewerId)
      .map((m) => (m.user_name ?? "").trim())
      .filter(Boolean);

    // "with you" earns the different preposition: it is the one huddle the
    // reader can act on without asking who is in it.
    if (withViewer) {
      return rest.length ? `in a huddle with you and ${nameList(rest)}` : "in a huddle with you";
    }
    if (rest.length) return `in a huddle · ${nameList(rest)}`;
    // Alone in a room they opened, waiting for someone to walk in.
    return "in a huddle";
  }

  return room?.label ? `in a huddle · ${room.label}` : "in a huddle";
}

/**
 * The one line that answers "what is this person doing right now", in words a
 * reader understands with no legend. Most-specific first: a live voice, then a
 * room, then their agents, then the plain presence fact.
 *
 * Every surface that shows a person — the strip's hover card, the people
 * window, a roster row — prints THIS, so they can never phrase the same
 * situation two ways.
 */
export function presenceActivityLine(member: any, ctx: PresenceActivityCtx): string {
  if (ctx.talking) return "talking on the walkie";

  const room = ctx.room;
  if (member?.in_room_key || member?.in_huddle || room) {
    // A locked room the viewer is not in: say it is locked rather than who is
    // in it. NOT because the server withholds the roster — it does not, and a
    // comment here used to claim it did. `calls.getLiveRooms` redacts only a
    // SESSION room's title, and sends `members` for every room it lists at
    // all. This is a choice: a locked door's whole point is that what is
    // behind it is not being announced, and "in a locked huddle" is the one
    // useful thing to say about it anyway — it tells you to knock.
    if (room?.locked && !member?.in_room_key) return "in a locked huddle";
    return huddleLine(member, ctx);
  }

  const fleet = ctx.fleet;
  if (fleet?.working) {
    const head = `${agents(fleet.working)} working`;
    return fleet.topTitle ? `${head} · ${fleet.topTitle}` : head;
  }
  if (fleet?.needsYou) return `needs to answer ${agents(fleet.needsYou)}`;

  const state = memberPresenceVisual(member);
  if (state === "busy") return "busy";
  if (state === "idle") {
    const at = member?.presence_input_at;
    return typeof at === "number" ? `idle ${compactDuration(ctx.now - at)}` : "idle";
  }
  if (state === "away") return "away";
  if (state === "active") return "active now";
  const seen = member?.daemon_last_seen;
  return typeof seen === "number"
    ? `last seen ${compactDuration(ctx.now - seen)} ago`
    : "offline";
}
