// What a huddle room is called, derived live from the store — one rule for
// the dock pill, the stage, the ring toast's "about:" line and every start
// button, so the same room never reads differently on two surfaces.
//
// A room is a key (@codecast/shared/contracts/callRoomKeys); its people, its
// channel or its session live in the store, so this stays a pure function of
// (key, state) and re-derives at render (lib/liveEntities' rule — a renamed
// teammate renames the huddle everywhere at once).
import { parseRoomKey } from "@codecast/shared/contracts";
import { channelDisplayName } from "../chatViews";

type Store = {
  teamMembers: any[];
  currentUser: any | null;
  chatChannels: Record<string, any>;
  /** The server's rail rows carry a restricted room's roster (member_ids). */
  chatRail?: { channel_id: string; member_ids?: string[] }[];
  /** Live rosters: guests rung into a room are here and nowhere in the key. */
  callOccupancy?: Record<string, { user_id: string }[]>;
  conversations: Record<string, any>;
  sessions: Record<string, any>;
  /** The live huddles (calls.getLiveRooms). They carry the server's ruling on
   *  whether this viewer may READ a room's name, which describeRoomLive
   *  applies. */
  liveRooms?: LiveRoomName[];
};

/** The naming half of a live room row: what the server was willing to tell
 *  this viewer about what the room is called. */
export type LiveRoomName = { room_key: string; redacted?: boolean; title?: string };

export type RoomDescription = {
  /** Short name for the dock pill and stage header. */
  label: string;
  /** The ring's context line for channel and session rooms, ready to read
   *  under "<caller> wants to huddle": "#design", "about: <session title>".
   *  People rooms return none — the server derives theirs per recipient
   *  (calls.invite), since a caller-written line would name the recipient to
   *  themselves. Travels as call_invites.anchor_title, rendered verbatim by
   *  the web toast, the push body and the phone's ring screen. */
  anchorTitle?: string;
  /** People the room names besides the viewer (dm rooms only). */
  otherIds: string[];
};

// One naming rule for "these people's room": channelDisplayName — the same
// one the chat rail uses, so a group reads identically as a thread and as a
// huddle ("Ann, Bo").
function peopleLabel(others: string[], s: Store): string {
  if (others.length === 0) return "Huddle";
  return channelDisplayName({ name: "", kind: "dm", dmMemberIds: others }, s.teamMembers);
}

/** Naming a room the viewer sees from OUTSIDE (the live-rooms lists). Two
 *  cases the store alone cannot answer:
 *  - `redacted`: a session huddle whose conversation this viewer cannot see.
 *    The room is joinable and its people are audible, but its name is not
 *    theirs to read, so it is "a huddle" and NOTHING is looked up.
 *  - `serverTitle`: the anchor's title as calls.getLiveRooms sent it, for
 *    rooms whose channel or conversation was never pulled into this client's
 *    store. Used only where the store has nothing better. */
export type DescribeOpts = { redacted?: boolean; serverTitle?: string };

export function describeRoom(
  roomKey: string | null,
  s: Store,
  opts?: DescribeOpts,
): RoomDescription {
  if (opts?.redacted) return { label: "a huddle", otherIds: [] };
  const parsed = roomKey ? parseRoomKey(roomKey) : null;
  if (!parsed) return { label: "Huddle", otherIds: [] };
  const me = String(s.currentUser?._id ?? "");

  if (parsed.kind === "dm") {
    // The key names the room's members; the live roster adds its guests
    // (people rung in are in occupancy and nowhere in the key). Union, so
    // "Bob" becomes "Bob, Cy" the moment Cy answers.
    const others = new Set(parsed.users.filter((id) => id !== me));
    for (const m of (roomKey && s.callOccupancy?.[roomKey]) || []) {
      if (String(m.user_id) !== me) others.add(String(m.user_id));
    }
    return { label: peopleLabel([...others], s), otherIds: [...others] };
  }

  if (parsed.kind === "channel") {
    const ch = s.chatChannels?.[parsed.channelId];
    if (!ch) {
      const name = opts?.serverTitle ? `#${opts.serverTitle}` : "Channel huddle";
      return { label: name, anchorTitle: opts?.serverTitle ? name : undefined, otherIds: [] };
    }
    if (ch.kind === "dm") {
      // A DM channel that huddles in its channel room (roster unknown at
      // key time): name it the way the rail does.
      const roster = s.chatRail?.find((r) => String(r.channel_id) === parsed.channelId)?.member_ids ?? [];
      const others = roster.filter((id: string) => String(id) !== me);
      return { label: peopleLabel(others, s), otherIds: others };
    }
    const name = ch.name ? `#${ch.name}` : "Channel huddle";
    return { label: name, anchorTitle: name, otherIds: [] };
  }

  // A recording names one person's microphone, and there is nothing to look
  // up: no room, no roster, no anchor. It never reaches the live lists (no
  // seats exist for it), so this is the fallback for a key that arrives from
  // a transcript row.
  if (parsed.kind === "rec") {
    return { label: "Recording", otherIds: [] };
  }

  // session
  const conv =
    s.conversations?.[parsed.conversationId] ??
    Object.values(s.conversations ?? {}).find((c: any) => String(c?._id) === parsed.conversationId) ??
    Object.values(s.sessions ?? {}).find((c: any) => String(c?._id) === parsed.conversationId);
  const title = conv?.title || conv?.name || opts?.serverTitle;
  return {
    label: title ? String(title) : "Session huddle",
    anchorTitle: title ? `about: ${String(title)}` : undefined,
    otherIds: [],
  };
}

// Naming a room the LIVE list knows about — the only entry point any surface
// should use once calls.getLiveRooms is in the store.
//
// Why this exists rather than each caller passing its own opts: the open door
// means a viewer can now be SEATED in a session room whose conversation they
// cannot see, and the dock and the stage header name the room they are in. If
// the redaction lived only on the listing path, an incidental copy of that
// conversation in the local cache would put its real title on screen the
// moment they walked in. One function, so the room a listing calls "a huddle"
// cannot introduce itself by name after you enter it.
export function describeRoomLive(roomKey: string | null, s: Store): RoomDescription {
  const live = roomKey ? (s.liveRooms ?? []).find((r) => r.room_key === roomKey) : undefined;
  return describeRoom(roomKey, s, { redacted: live?.redacted, serverTitle: live?.title });
}
