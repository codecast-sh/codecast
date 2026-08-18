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
};

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

export function describeRoom(roomKey: string | null, s: Store): RoomDescription {
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
    if (!ch) return { label: "Channel huddle", otherIds: [] };
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

  // session
  const conv =
    s.conversations?.[parsed.conversationId] ??
    Object.values(s.conversations ?? {}).find((c: any) => String(c?._id) === parsed.conversationId) ??
    Object.values(s.sessions ?? {}).find((c: any) => String(c?._id) === parsed.conversationId);
  const title = conv?.title || conv?.name;
  return {
    label: title ? String(title) : "Session huddle",
    anchorTitle: title ? `about: ${String(title)}` : undefined,
    otherIds: [],
  };
}
