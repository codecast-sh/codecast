// What a huddle room is called, derived live from the store — one rule for
// the dock pill, the stage, the ring toast's "about:" line and every start
// button, so the same room never reads differently on two surfaces.
//
// A room is a key (@codecast/shared/contracts/callRoomKeys); its people, its
// channel or its session live in the store, so this stays a pure function of
// (key, state) and re-derives at render (lib/liveEntities' rule — a renamed
// teammate renames the huddle everywhere at once).
import { parseRoomKey } from "@codecast/shared/contracts";
import { memberDisplayName } from "../liveEntities";
import { channelDisplayName } from "../chatViews";

type Store = {
  teamMembers: any[];
  currentUser: any | null;
  chatChannels: Record<string, any>;
  /** The server's rail rows carry a restricted room's roster (member_ids). */
  chatRail?: { channel_id: string; member_ids?: string[] }[];
  conversations: Record<string, any>;
  sessions: Record<string, any>;
};

export type RoomDescription = {
  /** Short name for the dock pill and stage header. */
  label: string;
  /** The ring's context line, ready to read under "<caller> wants to
   *  huddle": "with Sam, Ana", "#design", "about: <session title>".
   *  Undefined when the room needs no explanation beyond the caller's name
   *  (a 1:1). Travels as call_invites.anchor_title and is rendered verbatim
   *  by the web toast, the push body and the phone's ring screen. */
  anchorTitle?: string;
  /** People the room names besides the viewer (dm rooms only). */
  otherIds: string[];
};

function firstName(name: string): string {
  return name.split(/\s+/)[0] || name;
}

export function describeRoom(roomKey: string | null, s: Store): RoomDescription {
  const parsed = roomKey ? parseRoomKey(roomKey) : null;
  if (!parsed) return { label: "Huddle", otherIds: [] };
  const me = String(s.currentUser?._id ?? "");
  const byId = new Map((s.teamMembers ?? []).map((m: any) => [String(m._id), m]));

  if (parsed.kind === "dm") {
    const others = parsed.users.filter((id) => id !== me);
    const names = others.map((id) => memberDisplayName(byId.get(id), "Teammate"));
    const short = names.map((n) => (names.length > 1 ? firstName(n) : n));
    const label = short.length <= 2 ? short.join(" & ") || "Huddle" : `Huddle · ${short.length + 1}`;
    return {
      label,
      anchorTitle: others.length > 1 ? `with ${short.join(", ")}` : undefined,
      otherIds: others,
    };
  }

  if (parsed.kind === "channel") {
    const ch = s.chatChannels?.[parsed.channelId];
    if (!ch) return { label: "Channel huddle", otherIds: [] };
    if (ch.kind === "dm") {
      // A DM channel that huddles in its channel room (roster unknown at
      // key time): name it the way the rail does.
      const roster = s.chatRail?.find((r) => String(r.channel_id) === parsed.channelId)?.member_ids ?? [];
      const others = roster.filter((id: string) => String(id) !== me);
      const name = channelDisplayName({ name: "", kind: "dm", dmMemberIds: others }, s.teamMembers);
      return { label: name, anchorTitle: `with ${name}`, otherIds: others };
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
