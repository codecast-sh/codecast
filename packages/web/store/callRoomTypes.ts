// The huddle rows the store holds for calls: each live room's flags
// (`callRooms`), the live rooms themselves (`liveRooms`), the guests waiting
// on the viewer's links, and the knocks at the door of the room they are in.

/** The flags a person toggles from inside a huddle: one `callRooms` row per
 *  live room, keyed by room_key. calls.getLiveRooms carries them and
 *  useCallSync files them here, apart from the roster (`liveRooms`). */
export type CallRoomFlags = {
  _id: string;
  /** The room's door, as a fact about the ROOM: what the lock glyph paints. */
  locked: boolean;
  /** The huddle turned transcription off (calls.setRoomTranscribeOff) — what
   *  keeps every seated client's auto-scribe from starting it again. */
  transcribe_off: boolean;
  /** When the opt-out was switched on; null while transcription is on. */
  transcribe_off_at: number | null;
  /** The live record's public link is on: the transcript reaches anyone
   *  holding it as it is written. Absent on rows from an older server. */
  words_public?: boolean;
  /** The room is being recorded on LiveKit's servers (callRecordings): a run
   *  is starting or filming. What every call surface's red mark paints, for
   *  everyone in the room. Absent on rows from a server that predates it. */
  recording?: boolean;
};

/** One live huddle as calls.getLiveRooms projects it, minus the room flags
 *  (those live in `callRooms`). A room the viewer may not see the anchor of
 *  arrives `redacted` with no title — the room is still joinable (the team
 *  wall holds), only its name is withheld. */
export type LiveRoom = {
  room_key: string;
  team_id: string;
  /** May THIS viewer walk in right now — the server's own authorizeRoom answer.
   *  A lock shuts the open door only, so a member of the room or a guest
   *  holding a live grant is still true here while `locked` is too. This, never
   *  `locked`, decides Join versus Knock. */
  can_join: boolean;
  redacted: boolean;
  title?: string;
  members: { user_id: string; user_name?: string; user_image?: string; muted?: boolean }[];
  /** People from outside the team let in on a guest link (callGuests).
   *  Their own list, never mixed into `members`: a member is a users id every
   *  reader resolves, a guest is `identity` (`guest:<id>`) and a typed name. */
  guests?: LiveRoomGuest[];
};

/** A guest waiting on one of MY links at a room nobody is in
 *  (callGuests.listGuestsWaiting). `present_until` is where their lease ends
 *  as of their last beat: a row past it is somebody who closed the page. */
export type GuestWaiting = {
  guest_id: string;
  name: string;
  room_key: string;
  /** The meeting as the guest's link names it; null when it has no name. */
  title: string | null;
  knocked_at: number;
  present_until: number;
};

/** A guest inside a live room, as calls.getLiveRooms projects them. */
export type LiveRoomGuest = { guest_id: string; identity: string; name: string; joined_at: number };

/** Someone waiting at the door of the room I'm in (calls.getRoomKnocks). A
 *  teammate's knock is answered with a ring; a guest's (`kind: "guest"`,
 *  `from_user` is their `guest:<id>` identity, never a users id) with
 *  callGuests.admitGuest. */
export type RoomKnock = {
  from_user: string;
  from_name: string;
  from_image?: string;
  created_at: number;
  kind?: "person" | "guest";
  /** May THIS viewer answer the door (the inviter rule); no buttons if not. */
  can_answer?: boolean;
  guest_id?: string;
  link_id?: string;
  /** People already turned away or put out from the same link: past one,
   *  the door offers to turn the link off. */
  link_turned_away?: number;
  /** Whose link brought a guest (a teammate's name), and whether it is the
   *  viewer's own: the door says "via Sam's link". */
  link_by?: string;
  link_mine?: boolean;
};
