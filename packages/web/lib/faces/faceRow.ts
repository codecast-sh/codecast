import type { FaceState } from "./faceState";
export type { FaceState } from "./faceState";
// THE FACE ROW: presence, walkie, ringing and calls as the same faces in
// different states (pl-756).
//
// One pure function, `deriveFaceRow`, turns everything the app knows about the
// people around the viewer into ONE row: the entries in display order, the
// links drawn between faces, the one transient card the engagement needs, and
// the viewer's own face while they are engaged. Every surface that draws a
// face (the header bar, the floating window, the call stage) reads this row,
// and every surface that asks "is this person in a call" or "is this person
// talking" reads the selectors at the bottom. Eleven derivations of those two
// questions disagreed at the seams; this is the one that replaces them.
//
// HYSTERESIS LIVES HERE, NOT IN COMPONENTS. Engagement derives from the
// walkie's live room (the canonical fact) plus the room's occupancy, and never
// from the local call phase alone: a LiveKit reconnect keeps the call, my own
// linger after Stop keeps me on the row, and a face I was talking to never
// drops back to plain presence between the end of my burst and the far side's
// join while the walkie still holds the room. `prev` is how a state is held
// through a seam window so the row never reads off, then on.
//
// ORDER IS STABLE. An entry moves only when its link or its tier changes,
// never on a level tick, a heartbeat, or a mute. Linked faces keep the order
// they were linked in; everyone else sorts by presence band and name, the
// same rule every roster already uses (compareMembersByPresence).
//
// The module level reader at the bottom (`readFaceRow`) is the one derivation
// shared by React (hooks/useFaceRow) and non React readers (engine callbacks,
// the desktop bridge). It is memoized on a signature of its inputs, so a store
// push that changed nothing a face draws hands back the same row object.
import { parseRoomKey } from "@codecast/shared/contracts";
import { JOIN_TITLE_MS, getJoinAnnouncement, subscribeJoinAnnouncement, type JoinAnnouncement } from "../calls/joinAnnounce";
import { getCallTiles, subscribeCallTiles } from "../calls/callManager";
import {
  getWalkieStatus,
  subscribeWalkie,
  walkieCallState,
  walkieHoldsRoom,
  walkieJoinedRoom,
  type WalkieLiveRoom,
  type WalkieStatus,
} from "../calls/walkie";
import {
  senderHearing,
  walkieStageWords,
  type SenderHearing,
  type WalkieStageWords,
} from "../../hooks/useWalkie";
import {
  compareMembersByPresence,
  memberPresenceState,
  memberPresenceVisual,
  teamBarSig,
} from "../../components/presence/memberPresence";
import { dmBadgesByMember } from "../../components/people/peopleRoster";
import { memberAvatarUrl, memberDisplayName } from "../liveEntities";
import { describeRoomLive } from "../calls/roomLabels";
import { useInboxStore } from "../../store/inboxStore";
import { subscribeCoarseTick } from "../../hooks/useCoarseNow";

// ── vocabulary ──────────────────────────────────────────────────────────────

/** The ONE state vocabulary every surface draws from. */


/** Display bands, in row order. `linked` is every face joined to the viewer's. */
export const FACE_TIERS = ["me", "linked", "call", "online", "idle", "away", "offline"] as const;
export type FaceTier = (typeof FACE_TIERS)[number];

/** What the row draws BETWEEN two faces: the walkie's direction, a call, or a ring. */
export type LinkKind = "tx" | "rx" | "both" | "call" | "ring";
export type Link = { from: string; to: string; kind: LinkKind };

/** Which meter drives a face's mic ring: the viewer's own microphone, this
 *  person's voice (walkieMeter by their participant identity), or none. The
 *  level itself never passes through the model: it moves sixty times a second
 *  and would reorder nothing, so the ring reads it straight off the meter. */
export type FaceLevel = "mic" | "voice" | null;
/** Live video in the circle: the viewer's own camera, a remote camera track, or a photo. */
export type FaceVideo = "self" | "remote" | null;

export type FaceEntry = {
  id: string;
  name: string;
  image?: string;
  me: boolean;
  tier: FaceTier;
  state: FaceState;
  level: FaceLevel;
  video: FaceVideo;
  muted: boolean;
  followed: boolean;
  /** Milliseconds since they stepped in on purpose (a minute bucketed stamp),
   *  null when they did not. */
  joinedAgo: number | null;
  /** Unread messages in the viewer's DM with them. */
  unread: number;
  /** Their sessions waiting on the viewer. */
  ask: number;
};

export type FaceCard =
  | { kind: "none" }
  /** A teammate's burst is playing, or just stopped and the line is still open. */
  | {
      kind: "incoming";
      roomKey: string;
      from: string;
      name: string;
      reply: boolean;
      join: boolean;
      snooze: boolean;
      words: WalkieStageWords;
    }
  /** The viewer is talking or in a call. `words` is the walkie's stage while it
   *  holds the room; null for an ordinary huddle. `hearing` is what the roster
   *  says about the person being talked to, while the viewer's burst is out. */
  | {
      kind: "live";
      roomKey: string;
      title: string;
      end: true;
      mute: boolean;
      muted: boolean;
      /** The camera toggle is offered, and where it stands (the call slice). */
      camera: boolean;
      cameraOn: boolean;
      words: WalkieStageWords | null;
      hearing: SenderHearing | null;
    }
  /** Somebody stepped in: the live card, with the join said in words for a
   *  few seconds. Same controls as `live`, so nothing disappears under the notice. */
  | { kind: "joined-notice"; roomKey: string; text: string; end: true; mute: boolean; muted: boolean; camera: boolean; cameraOn: boolean }
  | { kind: "ring-in"; roomKey: string; from: string; name: string; answer: true; decline: true }
  | { kind: "ring-out"; roomKey: string; to: string; name: string; cancel: true; status: string };

export type FaceRow = {
  entries: FaceEntry[];
  links: Link[];
  card: FaceCard;
  /** The viewer's own face, present only while engaged; also entries[0] then. */
  me: FaceEntry | null;
  /** The room the viewer is engaged in, when any. */
  room: string | null;
};

// ── input ───────────────────────────────────────────────────────────────────

/** A roster row (teams.getTeamMembers), the fields a face reads. */
export type FaceMember = {
  _id: unknown;
  name?: string;
  email?: string;
  image?: string;
  github_avatar_url?: string;
  github_username?: string;
  presence_state?: string;
  status?: string;
  in_huddle?: boolean;
  in_room_key?: string;
  /** What their seat means to somebody outside the room (calls.roomSeatClass). */
  seat?: "call" | "walkie";
  walkie_joined_at?: number;
  walkie_pref?: string;
  walkie_snoozed_until?: number;
};

/** A seat (calls.getRoomOccupancy / getLiveRooms members). */
export type FaceSeat = {
  user_id: unknown;
  muted?: boolean;
  camera?: boolean;
  walkie_joined_at?: number;
};

export type FaceLiveRoom = { room_key: string; seat?: "call" | "walkie"; members: FaceSeat[] };

export type FaceRowInput = {
  viewer: { id: string; name?: string; image?: string } | null;
  roster: FaceMember[];
  occupancy: Record<string, FaceSeat[]>;
  liveRooms: FaceLiveRoom[];
  walkie: {
    liveRoom: WalkieLiveRoom | null;
    sending: { roomKey: string; live: boolean; heardLive: boolean } | null;
    incoming: { fromUserId: string; roomKey: string } | null;
    canReply: boolean;
  };
  call: {
    phase: string;
    roomKey: string | null;
    muted: boolean;
    micDenied: boolean;
    camera: boolean;
    speaking: string[];
  };
  tiles: { identity: string; isLocal: boolean; kind: string }[];
  followLeaderId: string | null;
  rings: {
    incoming: { from_user: unknown; room_key: string; from_name?: string }[];
    outgoing: { to_user: unknown; room_key: string; to_name?: string; status?: string }[];
  };
  announcement: JoinAnnouncement | null;
  unread: ReadonlyMap<string, number>;
  ask: ReadonlyMap<string, number>;
  /** The engaged room's name (describeRoomLive); the named teammate's name
   *  stands in for a people room when absent. */
  roomLabel?: string;
  now: number;
};

// ── the model ───────────────────────────────────────────────────────────────

const ENGAGED: ReadonlySet<FaceState> = new Set([
  "talking-to-me",
  "hearing-me",
  "live-with-me",
  "joining",
  "speaking",
]);

const EMPTY_ROW: FaceRow = { entries: [], links: [], card: { kind: "none" }, me: null, room: null };

function idOf(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Every seat the model knows in a room: the occupancy feed, and the live
 *  rooms list for rooms the occupancy subscription has not opened. */
function seatsIn(input: FaceRowInput, roomKey: string | null): FaceSeat[] {
  if (!roomKey) return [];
  const seated = input.occupancy[roomKey];
  if (seated && seated.length > 0) return seated;
  return input.liveRooms.find((r) => r.room_key === roomKey)?.members ?? [];
}

/**
 * THE ROOM THE VIEWER IS ENGAGED IN. The walkie's live room is canonical: it
 * is non null from the instant of a press until the seat is handed back, so
 * the linger after Stop and the listen after a burst both count. An ordinary
 * huddle is the call plane's room while its phase is anything but idle, which
 * includes a LiveKit reconnect (phase `connecting`) and the local first
 * `connecting` before any round trip. A seat the roster still shows the viewer
 * in (another window is the voice host) counts too. The phase alone never
 * decides against the other two: a room the walkie holds is engaged even when
 * the call plane went idle under it.
 */
function engagedRoomOf(input: FaceRowInput): string | null {
  const walkieRoom = input.walkie.liveRoom?.key ?? null;
  if (walkieRoom) return walkieRoom;
  if (input.call.phase !== "idle" && input.call.roomKey) return input.call.roomKey;
  const me = input.viewer?.id ?? "";
  if (!me) return null;
  const seated = input.liveRooms.find((r) => r.members.some((m) => idOf(m.user_id) === me));
  return seated?.room_key ?? null;
}

/** Burst, listen or call: what the engaged room IS. */
function roomModeOf(input: FaceRowInput, room: string | null): "burst" | "listen" | "call" | null {
  if (!room) return null;
  const live = input.walkie.liveRoom;
  if (live && live.key === room) return live.mode;
  return "call";
}

function presenceStateOf(m: FaceMember): FaceState {
  const v = memberPresenceVisual(m);
  return v === "active" ? "online" : v;
}

function presenceTierOf(m: FaceMember): FaceTier {
  const s = memberPresenceState(m);
  return s === "active" ? "online" : s;
}

function linkKindOf(input: FaceRowInput, mode: "burst" | "listen" | "call", id: string): LinkKind {
  const tx = !!input.walkie.sending;
  const rx = input.walkie.incoming?.fromUserId === id;
  if (tx && rx) return "both";
  if (mode === "call") return "call";
  return mode === "burst" ? "tx" : "rx";
}

/**
 * The state of one teammate's face relative to the viewer. Rings first (they
 * need an answer), then the voice playing here, then the engaged room, then
 * what the roster says about rooms the viewer is not in, then presence.
 */
function stateOf(
  input: FaceRowInput,
  m: FaceMember,
  ctx: {
    id: string;
    room: string | null;
    mode: "burst" | "listen" | "call" | null;
    inMyRoom: boolean;
    named: boolean;
    prev: FaceEntry | undefined;
  },
): FaceState {
  const { id, room, mode, inMyRoom, named, prev } = ctx;
  if (input.rings.incoming.some((r) => idOf(r.from_user) === id)) return "ringing-me";
  if (input.rings.outgoing.some((r) => idOf(r.to_user) === id && (r.status ?? "ringing") === "ringing")) {
    return "ringing-them";
  }
  // They answered. The ring settles a round trip before their seat lands, so
  // a face that was ringing stays ringing until it is seated in my call (the
  // server keeps the accepted ring in view for that window); it never reads
  // online in between. A cancelled, declined or expired ring is not held.
  if (
    prev?.state === "ringing-them" &&
    room &&
    mode === "call" &&
    !inMyRoom &&
    input.rings.outgoing.some((r) => idOf(r.to_user) === id && r.room_key === room && r.status === "accepted")
  ) {
    return "ringing-them";
  }
  if (input.walkie.incoming?.fromUserId === id) return "talking-to-me";
  if (room && mode) {
    if (inMyRoom) {
      const ann = input.announcement;
      if (mode === "call" && ann && ann.roomKey === room && input.now - ann.at < JOIN_TITLE_MS) return "joining";
      if (mode === "call" && input.call.speaking.includes(id)) return "speaking";
      if (mode === "burst" && input.walkie.sending) return "hearing-me";
      return "live-with-me";
    }
    // Named by the room but not seated: the far side of a burst before their
    // auto listen seats them, or a seat that lapsed for a tick. A face that
    // was engaged stays engaged while the walkie holds the room, as what the
    // room is now says (hearing me while my key is down, else live with me);
    // it never drops to plain presence and comes back. A face that was never
    // engaged is plain presence, and the link says who is being talked to.
    if (named && prev && ENGAGED.has(prev.state) && input.walkie.liveRoom?.key === room) {
      return mode === "burst" && input.walkie.sending ? "hearing-me" : "live-with-me";
    }
  }
  // A seat somewhere the viewer is not. A burst seats everyone who hears it
  // for the burst and its linger; the server's seat class says which is
  // which, so a burst is presence and a call is a call (memberInHuddle's
  // rule, with the answer the roster now carries).
  const theirRoom = m.in_room_key ? String(m.in_room_key) : "";
  const liveRow = input.liveRooms.find((r) => r.members.some((s) => idOf(s.user_id) === id));
  const seatClass = m.seat ?? liveRow?.seat;
  if ((m.in_huddle || theirRoom || liveRow) && seatClass !== "walkie") return "in-call";
  return presenceStateOf(m);
}

function tierOf(state: FaceState, linked: boolean, m: FaceMember): FaceTier {
  if (linked) return "linked";
  if (state === "in-call") return "call";
  return presenceTierOf(m);
}

function stageWordsFor(input: FaceRowInput, mode: "burst" | "listen" | "call", name: string): WalkieStageWords {
  const s = input.walkie.sending;
  const locked = mode === "call";
  return walkieStageWords({
    sending: s ? { live: s.live, heardLive: s.heardLive } : null,
    incoming: !!input.walkie.incoming,
    locked,
    muted: input.call.muted,
    // The room went away under an open microphone: still recording, heard by
    // nobody (walkieBurstDropped's rule, on the model's own inputs).
    dropped: !!s && input.call.phase === "idle",
    micDenied: input.call.micDenied,
    name,
  });
}

function cardOf(
  input: FaceRowInput,
  ctx: { room: string | null; mode: "burst" | "listen" | "call" | null; others: FaceEntry[]; label: string },
): FaceCard {
  const { room, mode, others, label } = ctx;
  const ringIn = input.rings.incoming[0];
  if (ringIn) {
    return {
      kind: "ring-in",
      roomKey: ringIn.room_key,
      from: idOf(ringIn.from_user),
      name: ringIn.from_name ?? "Teammate",
      answer: true,
      decline: true,
    };
  }
  const walkie = input.walkie;
  const other = others.find((e) => e.state !== "ringing-them" && e.state !== "ringing-me");
  const name = other?.name ?? label;
  if (room && mode === "listen") {
    return {
      kind: "incoming",
      roomKey: room,
      from: walkie.incoming?.fromUserId ?? other?.id ?? "",
      name,
      reply: walkie.canReply,
      join: true,
      snooze: true,
      words: stageWordsFor(input, "listen", name),
    };
  }
  // Ringing from inside the room: startHuddle seats the caller before the
  // ring goes out, so until somebody else is seated the card is the ring out
  // (ringing, declined, no answer), not a live call with nobody on it.
  const ringOutHere = other ? undefined : input.rings.outgoing.find((r) => r.room_key === room && r.status !== "accepted");
  if (room && mode === "call" && ringOutHere) return ringOutCard(ringOutHere);
  if (room && mode) {
    const end = true as const;
    const mute = mode === "call";
    const muted = input.call.muted;
    // The camera is offered on every live room: a burst opens one too, and a
    // person who would rather be a photo says so here.
    const camera = true;
    const cameraOn = !!input.call.camera;
    const ann = input.announcement;
    if (ann && ann.roomKey === room && input.now - ann.at < JOIN_TITLE_MS) {
      return { kind: "joined-notice", roomKey: room, text: ann.text, end, mute, muted, camera, cameraOn };
    }
    const walkieHeld = walkie.liveRoom?.key === room;
    let hearing: SenderHearing | null = null;
    if (mode === "burst" && walkie.sending?.heardLive && other) {
      const m = input.roster.find((r) => idOf(r._id) === other.id);
      hearing = senderHearing(seatsIn(input, room), input.viewer?.id, {
        userId: other.id,
        name: other.name,
        status: m?.status,
        pref: m?.walkie_pref,
        snoozed: Number(m?.walkie_snoozed_until ?? 0) > input.now,
      });
    }
    return {
      kind: "live",
      roomKey: room,
      title: label,
      end,
      mute,
      muted,
      camera,
      cameraOn,
      words: walkieHeld ? stageWordsFor(input, mode, name) : null,
      hearing,
    };
  }
  const ringOut =
    input.rings.outgoing.find((r) => (r.status ?? "ringing") === "ringing") ?? input.rings.outgoing.find((r) => r.status !== "accepted");
  if (ringOut) return ringOutCard(ringOut);
  return { kind: "none" };
}

function ringOutCard(r: FaceRowInput["rings"]["outgoing"][number]): FaceCard {
  return {
    kind: "ring-out",
    roomKey: r.room_key,
    to: idOf(r.to_user),
    name: r.to_name ?? "Teammate",
    cancel: true,
    status: r.status ?? "ringing",
  };
}

/**
 * The row. Pure: everything it reads is in `input`, and `prev` is the row it
 * last produced (or null), which is what lets a state hold through a seam.
 */
export function deriveFaceRow(input: FaceRowInput, prev: FaceRow | null): FaceRow {
  const viewer = input.viewer;
  if (!viewer?.id) return EMPTY_ROW;
  const meId = viewer.id;
  const room = engagedRoomOf(input);
  const mode = roomModeOf(input, room);
  const seats = seatsIn(input, room);
  const seatedIds = new Set(seats.map((s) => idOf(s.user_id)));
  const parsed = room ? parseRoomKey(room) : null;
  const namedIds = new Set(parsed?.kind === "dm" ? parsed.users.map(String) : []);
  const prevById = new Map((prev?.entries ?? []).map((e) => [e.id, e]));
  const prevOrder = new Map((prev?.entries ?? []).map((e, i) => [e.id, i]));
  const cameraOf = new Map<string, boolean>();
  for (const t of input.tiles) if (t.kind === "camera") cameraOf.set(t.identity, true);

  const rows: { entry: FaceEntry; member: FaceMember; linked: boolean }[] = [];
  const links: Link[] = [];
  for (const m of input.roster) {
    const id = idOf(m._id);
    if (!id || id === meId) continue;
    const prevEntry = prevById.get(id);
    // In my room by any of three reports: the occupancy feed, the live rooms
    // list, or their own roster row naming my room. Three sources so a face
    // never blinks while one of them catches up.
    const inMyRoom = !!room && (seatedIds.has(id) || (m.in_room_key ? String(m.in_room_key) === room : false));
    const named = namedIds.has(id);
    const state = stateOf(input, m, { id, room, mode, inMyRoom, named, prev: prevEntry });
    const ring = state === "ringing-me" || state === "ringing-them";
    // Linked: a ring either way, an engaged state (only ever earned in the
    // viewer's room), or being the person a people room the walkie holds is
    // named after, seated or not: the link is how "I am talking to them"
    // reads, and it is true from the first word, before their seat lands.
    const linked = ring || ENGAGED.has(state) || (named && !!room && input.walkie.liveRoom?.key === room);
    if (linked) {
      links.push({ from: meId, to: id, kind: ring ? "ring" : linkKindOf(input, mode ?? "call", id) });
    }
    const seat = seats.find((s) => idOf(s.user_id) === id);
    const stamp = m.walkie_joined_at ?? seat?.walkie_joined_at;
    const entry: FaceEntry = {
      id,
      name: memberDisplayName(m as any),
      image: memberAvatarUrl(m as any),
      me: false,
      tier: tierOf(state, linked, m),
      state,
      level: state === "talking-to-me" || state === "speaking" ? "voice" : null,
      video: inMyRoom && cameraOf.get(id) ? "remote" : null,
      muted: inMyRoom ? seat?.muted === true : false,
      followed: input.followLeaderId === id,
      joinedAgo: inMyRoom && stamp ? Math.max(0, input.now - stamp) : null,
      unread: input.unread.get(id) ?? 0,
      ask: input.ask.get(id) ?? 0,
    };
    rows.push({ entry, member: m, linked });
  }

  const rank = new Map(FACE_TIERS.map((t, i) => [t, i]));
  rows.sort((a, b) => {
    const ta = rank.get(a.entry.tier)!;
    const tb = rank.get(b.entry.tier)!;
    if (ta !== tb) return ta - tb;
    if (a.linked && b.linked) {
      // The order they were linked in; a face linked this tick goes after.
      const pa = prevOrder.get(a.entry.id) ?? Number.MAX_SAFE_INTEGER;
      const pb = prevOrder.get(b.entry.id) ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
    }
    return compareMembersByPresence(a.member, b.member);
  });

  const others = rows.map((r) => r.entry);
  const ringing = input.rings.incoming.length > 0 || input.rings.outgoing.some((r) => (r.status ?? "ringing") === "ringing");
  let me: FaceEntry | null = null;
  if (room || ringing) {
    const myRow = input.roster.find((m) => idOf(m._id) === meId);
    const sendingLive = !!input.walkie.sending?.live;
    const inCall = !!room;
    const state: FaceState = sendingLive || (inCall && input.call.speaking.includes(meId))
      ? "speaking"
      : inCall
        ? "in-call"
        : input.rings.incoming.length > 0
          ? "ringing-me"
          : "ringing-them";
    const micOpen = sendingLive || (inCall && mode === "call" && !input.call.muted);
    me = {
      id: meId,
      name: myRow ? memberDisplayName(myRow as any) : (viewer.name ?? "You"),
      image: myRow ? memberAvatarUrl(myRow as any) : viewer.image,
      me: true,
      tier: "me",
      state,
      level: micOpen ? "mic" : null,
      video: inCall && (input.call.camera || cameraOf.get(meId)) ? "self" : null,
      muted: inCall && mode === "call" ? input.call.muted : false,
      followed: false,
      joinedAgo: null,
      unread: 0,
      ask: 0,
    };
  }

  const label = input.roomLabel || others.find((e) => namedIds.has(e.id))?.name || "Huddle";
  const card = cardOf(input, { room, mode, others: others.filter((e) => e.tier === "linked"), label });
  const entries = me ? [me, ...others] : others;
  return { entries, links, card, me, room };
}

// ── the shared derivation ───────────────────────────────────────────────────
//
// One reader for React and everything else. The inputs are gathered from the
// store and the engine, signed, and the row is derived only when the signature
// moved: a heartbeat that changed no field a face draws hands back the SAME
// row object, which is what lets useSyncExternalStore skip the render and a
// non React caller compare by identity.

function seatSig(seats: FaceSeat[] | undefined): string {
  let s = "";
  for (const m of seats ?? []) s += `${idOf(m.user_id)}:${m.muted ? 1 : 0}:${m.camera ? 1 : 0}:${m.walkie_joined_at ?? ""},`;
  return s;
}

function occupancySig(occ: Record<string, FaceSeat[]> | undefined): string {
  let s = "";
  for (const k in occ ?? {}) s += `${k}=${seatSig(occ![k])};`;
  return s;
}

function liveRoomsSig(rooms: FaceLiveRoom[] | undefined): string {
  let s = "";
  for (const r of rooms ?? []) s += `${r.room_key}|${r.seat ?? ""}|${seatSig(r.members)}\n`;
  return s;
}

function rosterFaceSig(members: FaceMember[] | undefined): string {
  // teamBarSig carries identity, presence, status and the room; the walkie
  // fields the row adds ride beside it.
  let extra = "";
  for (const m of members ?? []) {
    if (!m?._id) continue;
    extra += `${m.seat ?? ""}|${m.walkie_joined_at ?? ""}|${m.walkie_pref ?? ""}|${m.walkie_snoozed_until ?? ""}\n`;
  }
  return teamBarSig((members ?? []) as any[]) + extra;
}

function ringsSig(myCalls: { incoming?: any[]; outgoing?: any[] } | undefined): string {
  let s = "";
  for (const r of myCalls?.incoming ?? []) s += `in:${idOf(r.from_user)}:${r.room_key}:${r.from_name ?? ""},`;
  for (const r of myCalls?.outgoing ?? []) s += `out:${idOf(r.to_user)}:${r.room_key}:${r.status ?? ""}:${r.to_name ?? ""},`;
  return s;
}

function walkieRowSig(w: WalkieStatus): string {
  const s = w.sending;
  const live = w.liveRoom;
  return `${live?.key ?? ""}|${live?.mode ?? ""}|${s ? `${s.roomKey}:${s.live ? 1 : 0}:${s.heardLive ? 1 : 0}` : ""}|${w.incoming?.fromUserId ?? ""}:${w.incoming?.roomKey ?? ""}|${w.canReply ? 1 : 0}|${walkieJoinedRoom(w) ?? ""}|${walkieHoldsRoom(w, null) ? 1 : 0}`;
}

function tilesSig(tiles: { identity: string; isLocal: boolean; kind: string }[]): string {
  let s = "";
  for (const t of tiles) if (t.kind === "camera") s += `${t.identity}:${t.isLocal ? 1 : 0},`;
  return s;
}

/** The clock the row needs: `joinedAgo` and a snooze running out move on
 *  this, the join notice on its own timer (JOIN_TITLE_MS is under one tick,
 *  so the announcement subscription is what wakes that seam). */
export const FACE_ROW_TICK_MS = 15_000;

/** Unread DM messages per teammate, from the store's rail rows. Only rooms
 *  with exactly one other person, the same rule the people window uses. */
export function dmUnreadByMember(st: any): ReadonlyMap<string, number> {
  const me = idOf(st.currentUser?._id);
  const rail: any[] = st.chatRail ?? [];
  const views = rail.map((r) => {
    const ch = st.chatChannels?.[r.channel_id];
    return {
      id: r.channel_id,
      kind: ch?.kind,
      dmMemberIds: (r.member_ids ?? []).filter((id: unknown) => idOf(id) !== me),
      unreadCount: r.unread ?? 0,
      mentionCount: r.unread_mentions ?? 0,
      muted: r.notify_level === "muted",
    };
  });
  const out = new Map<string, number>();
  for (const [id, badge] of dmBadgesByMember(views as any)) out.set(id, badge.unread);
  return out;
}

function railUnreadSig(st: any): string {
  let s = "";
  for (const r of st.chatRail ?? []) if (r.unread) s += `${r.channel_id}:${r.unread},`;
  return s;
}

/** What the model reads, as one string. Exported so a test can pin that a
 *  heartbeat moves nothing and a walkie change moves it. */
export function faceRowInputSig(
  st: any,
  walkie: WalkieStatus,
  announcement: JoinAnnouncement | null,
  tiles: { identity: string; isLocal: boolean; kind: string }[],
  now: number,
): string {
  const call = walkieCallState();
  return [
    idOf(st.currentUser?._id),
    st.currentUser?.name ?? "",
    st.currentUser?.image ?? "",
    rosterFaceSig(st.teamMembers),
    occupancySig(st.callOccupancy),
    liveRoomsSig(st.liveRooms),
    walkieRowSig(walkie),
    `${call.phase}|${call.roomKey ?? ""}|${call.muted ? 1 : 0}|${call.micDenied ? 1 : 0}|${call.camera ? 1 : 0}|${call.speaking.join(",")}`,
    tilesSig(tiles),
    st.followLeaderId ?? "",
    ringsSig(st.myCalls),
    announcement ? `${announcement.roomKey}|${announcement.at}` : "",
    railUnreadSig(st),
    String(Math.floor(now / FACE_ROW_TICK_MS)),
  ].join("\u0001");
}

/** The model's input, gathered from the store and the engine. `ask` (their
 *  sessions waiting on the viewer) is the one field not read here: it is a
 *  walk of every session, and hooks/useFaceRow overlays it from the fleet
 *  summaries it already keeps. */
export function faceRowInputFrom(
  st: any,
  walkie: WalkieStatus,
  announcement: JoinAnnouncement | null,
  tiles: { identity: string; isLocal: boolean; kind: string }[],
  now: number,
): FaceRowInput {
  // The call as the host holds it: in a remote window this window's own
  // slice is idle for as long as the host has the microphone, so the phase,
  // the camera and the speakers all come from the mirror or from nowhere.
  const call = walkieCallState();
  const u = st.currentUser;
  const room = walkie.liveRoom?.key ?? (call.phase !== "idle" ? call.roomKey : null);
  return {
    viewer: u?._id ? { id: idOf(u._id), name: u.name ?? u.email, image: u.image ?? u.github_avatar_url } : null,
    roster: st.teamMembers ?? [],
    occupancy: st.callOccupancy ?? {},
    liveRooms: st.liveRooms ?? [],
    walkie: {
      liveRoom: walkie.liveRoom,
      sending: walkie.sending
        ? { roomKey: walkie.sending.roomKey, live: walkie.sending.live, heardLive: walkie.sending.heardLive }
        : null,
      incoming: walkie.incoming ? { fromUserId: walkie.incoming.fromUserId, roomKey: walkie.incoming.roomKey } : null,
      canReply: walkie.canReply,
    },
    call: {
      phase: call.phase,
      roomKey: call.roomKey,
      muted: call.muted,
      micDenied: call.micDenied,
      camera: call.camera,
      speaking: call.speaking,
    },
    tiles,
    followLeaderId: st.followLeaderId ?? null,
    rings: { incoming: st.myCalls?.incoming ?? [], outgoing: st.myCalls?.outgoing ?? [] },
    announcement,
    unread: dmUnreadByMember(st),
    ask: EMPTY_ASK,
    roomLabel: room ? describeRoomLive(room, st).label : undefined,
    now,
  };
}

const EMPTY_ASK: ReadonlyMap<string, number> = new Map();

let lastSig = "";
let lastRow: FaceRow = EMPTY_ROW;
// The inputs the signature was last built from, by identity. A store write
// hands every subscriber the same state object, so the first reader after a
// write builds the signature and the rest compare five references: a roster
// of faces, each with its own subscription, costs one signature per write.
let lastInputs: { st: unknown; walkie: unknown; announcement: unknown; tiles: unknown; tick: number } | null = null;

/** A stand in for the engine, from the console: the walkie's status, the
 *  join announcement and the camera tiles as a demo wants them, so every
 *  state of the row can be looked at without a second person on the line.
 *  `window.__faceRow.fake({ walkie: {...} })` sets it, `fake(null)` clears it;
 *  the store half of the input (the roster, the seats, the rings, the call
 *  plane) is faked through `window.__inboxStore` as everything else is. */
type FaceRowFake = {
  walkie?: Partial<WalkieStatus>;
  announcement?: JoinAnnouncement | null;
  tiles?: { identity: string; isLocal: boolean; kind: string }[];
  /** Laid over the gathered input last: seats, rings and the call plane as
   *  the demo wants them, with no store write and so no engine reacting. */
  input?: Partial<Omit<FaceRowInput, "walkie" | "announcement" | "tiles">>;
};
let fake: FaceRowFake | null = null;
let fakeSeq = 0;
export function fakeFaceRowInput(patch: FaceRowFake | null): void {
  fake = patch;
  fakeSeq++;
  lastInputs = null;
  // Wake the readers the way an engine push would.
  for (const cb of fakeListeners) cb();
}
const fakeListeners = new Set<() => void>();

/** The row, derived once per change of its inputs and shared by every reader. */
export function readFaceRow(): FaceRow {
  const st = useInboxStore.getState();
  const walkie = fake?.walkie ? { ...getWalkieStatus(), ...fake.walkie } : getWalkieStatus();
  const announcement = fake && "announcement" in fake ? (fake.announcement ?? null) : getJoinAnnouncement();
  const tiles = fake?.tiles ?? getCallTiles();
  const now = Date.now();
  const tick = Math.floor(now / FACE_ROW_TICK_MS);
  const li = lastInputs;
  if (li && li.st === st && li.walkie === walkie && li.announcement === announcement && li.tiles === tiles && li.tick === tick) {
    return lastRow;
  }
  lastInputs = { st, walkie, announcement, tiles, tick };
  const sig = faceRowInputSig(st, walkie, announcement, tiles, now) + (fake ? `\u0001fake${fakeSeq}` : "");
  if (sig === lastSig) return lastRow;
  lastSig = sig;
  const gathered = faceRowInputFrom(st, walkie, announcement, tiles, now);
  lastRow = deriveFaceRow(fake?.input ? { ...gathered, ...fake.input } : gathered, lastRow);
  return lastRow;
}

/** Wakes on every source the row reads. The store subscription fires on
 *  every store write; the signature inside readFaceRow is what turns that
 *  into a render only when a face changed. */
export function subscribeFaceRow(cb: () => void): () => void {
  const offs = [
    useInboxStore.subscribe(cb),
    subscribeWalkie(cb),
    subscribeJoinAnnouncement(cb),
    subscribeCallTiles(cb),
    subscribeCoarseTick(FACE_ROW_TICK_MS, cb),
  ];
  fakeListeners.add(cb);
  return () => {
    for (const off of offs) off();
    fakeListeners.delete(cb);
  };
}

/** Forget the memoized row (tests). */
export function resetFaceRow(): void {
  lastSig = "";
  lastRow = EMPTY_ROW;
  lastInputs = null;
  fake = null;
}

// Every build exposes the fake beside the store (window.__inboxStore), so a
// demo or a screenshot pass can put the row in any state from the console.
if (typeof window !== "undefined") {
  (window as any).__faceRow = { fake: fakeFaceRowInput, read: readFaceRow };
}

// ── selectors ───────────────────────────────────────────────────────────────
//
// The two questions eleven surfaces used to answer for themselves. Both read
// the shared row, so a chip, a pill and the desktop bridge cannot disagree.

/** This person's face state, `offline` for somebody the row does not know. */
export function engagementOf(memberId: string, row: FaceRow = readFaceRow()): FaceState {
  return row.entries.find((e) => e.id === memberId)?.state ?? "offline";
}

const TALKING: ReadonlySet<FaceState> = new Set(["talking-to-me", "speaking"]);
const IN_CALL: ReadonlySet<FaceState> = new Set([
  "in-call",
  "speaking",
  "talking-to-me",
  "hearing-me",
  "live-with-me",
  "joining",
]);

/** Their voice is audible right now: a burst playing here, or an active
 *  speaker in the viewer's call. For the viewer: their own microphone is live. */
export function isTalking(memberId: string, row: FaceRow = readFaceRow()): boolean {
  return TALKING.has(engagementOf(memberId, row));
}

/** Seated in a live room: a call anywhere, or the room the viewer holds. A
 *  ring is not a call yet, and a third party's burst is not one either. */
export function isInCall(memberId: string, row: FaceRow = readFaceRow()): boolean {
  return IN_CALL.has(engagementOf(memberId, row));
}

/** The link kinds the walkie draws: a voice in flight, not a conversation. */
const BURST_LINKS: ReadonlySet<LinkKind> = new Set(["tx", "rx", "both"]);

/** Seated in a CALL, the thing a huddle chip claims: a call anywhere, or the
 *  viewer's room once somebody is in it on purpose. A burst with the viewer is
 *  a seat too (everyone who hears a burst holds one for its linger), but it is
 *  drawn as a link and a ring, never as a chip: a voice message is not a
 *  conversation. The rule memberInHuddle used to answer off the roster and
 *  the walkie, on the row. */
export function isInHuddle(memberId: string, row: FaceRow = readFaceRow()): boolean {
  if (!isInCall(memberId, row)) return false;
  const link = row.links.find((l) => l.to === memberId);
  return !link || !BURST_LINKS.has(link.kind);
}

/** The viewer's engaged room is this one, and the walkie holds it as a burst
 *  or a listen rather than a call: what the links say about it. The surfaces
 *  that stand down while a burst plays (the room's occupancy chip) ask this,
 *  and the row says the room became a call the moment its links do. */
export function roomHeldAsBurst(roomKey: string, row: FaceRow = readFaceRow()): boolean {
  return row.room === roomKey && row.links.some((l) => BURST_LINKS.has(l.kind));
}
