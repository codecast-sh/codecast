// Tables for a huddle's room around its seats: hang-up marks, invites,
// knocks, and the guest links and guests that let outsiders into a call.

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { callGuestLeftReasonValidator, callGuestStatusValidator, guestNoticeValidator } from "./lib/callValidators";

export const callRoomTables = {
  // A HANG-UP, kept so the person's other clients hear it. A seat is one per
  // person per room, so pressing End on one device deletes the seat a tab on
  // another device is still holding media for. That tab's next heartbeat finds
  // no row, and without this mark it reads as a lease sweep (the laptop slept)
  // and takes the seat back: End undone within 15s. With it, the heartbeat
  // answers "hung up" and that client leaves too. One row per person and room,
  // cleared by the next real join.
  call_hangups: defineTable({
    user_id: v.id("users"),
    room_key: v.string(),
    at: v.number(),
  }).index("by_user_room", ["user_id", "room_key"]),

  // A ring. Sync-driven, not push-driven: the recipient's client subscribes to
  // its own ringing rows (calls.getMyCalls) and renders the toast/sound
  // locally. TTL'd — a ring older than CALL_INVITE_TTL_MS reads as expired and
  // is deleted opportunistically by the next mutation that touches the pair,
  // so no cron and no zombie ringing. One active ring per (from,to) pair at a
  // time; re-inviting refreshes the existing row.
  call_invites: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    from_user: v.id("users"),
    to_user: v.id("users"),
    status: v.union(
      v.literal("ringing"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("cancelled"),
      v.literal("expired"),
    ),
    // The ring's context line, ready to read under "<caller> wants to
    // huddle": "about: <session title>", "with Sam, Ana", "#design". Rendered
    // verbatim by the web toast, the push body and the phone's ring screen.
    // Resolved at invite time under the CALLER's visibility — the callee is
    // being invited into it, which is exactly the sharing gesture.
    anchor_title: v.optional(v.string()),
    created_at: v.number(),
    // Set when the recipient answers either way; lets the caller's UI settle.
    responded_at: v.optional(v.number()),
  })
    .index("by_to_status", ["to_user", "status"])
    // The invite grant (callRooms.acceptedInviteGrant): "was I rung into
    // THIS room" — the door a non-member enters a live huddle through.
    .index("by_to_room", ["to_user", "room_key"])
    .index("by_from_status", ["from_user", "status"])
    .index("by_room", ["room_key"]),

  // A room's door. Huddles are open by default (a live room admits any member
  // of its billing team — callRooms.openRoomDoor), so this table exists only
  // to say "not right now": one row per room, written by whoever is inside.
  // A lock belongs to the huddle that set it, not to the room, so it dies
  // with that huddle — joinRoom clears it (clearRoomState) whenever the room
  // restarts from empty, exactly like the invite grants. Locking never
  // touches membership or grants: the people whose room it is, and anyone
  // rung in, still walk through.
  call_room_state: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    locked: v.boolean(),
    locked_by: v.id("users"),
    // A PRIVATE HUDDLE, chosen at start (calls.joinRoom `private`). It is
    // locked like any locked room, and goes further: teammates outside it do
    // not see it in their live rooms at all, a teammate who can merely see
    // the session it is about is not let in (only its owner and whoever made
    // it private), and the call record is marked private too
    // (transcripts.private). Dies with the huddle like the lock; opening the
    // door clears it.
    private: v.optional(v.boolean()),
    // The huddle's opt-out from transcription. Every huddle transcribes by
    // default (any deliberate participant's client becomes the scribe), so
    // "stop transcribing" has to be a fact about the ROOM or the next client
    // to look would simply start again. Same lifetime as the lock: it belongs
    // to this huddle and dies with it.
    transcribe_off: v.optional(v.boolean()),
    // When the opt-out was last switched ON. A scribe whose run began before
    // this stamp is the one being told to stop; a stale "off" the store still
    // shows for a beat after somebody switched transcription back on by hand
    // predates their run and must not end it (autoScribe).
    transcribe_off_at: v.optional(v.number()),
    // When the last seat left this huddle's room (calls.leaveRoom). The
    // huddle's grace dates from it when no live record carries an idle stamp
    // of its own (transcription off, or nobody scribing yet), so a teammate
    // who reloads the tab comes back to the same huddle, with its grants and
    // its guests, whether or not anything was transcribing it
    // (transcripts.withinHuddleGrace). Dies with the row like the rest.
    emptied_at: v.optional(v.number()),
    // The huddle's live call record has its public link on, which shows the
    // transcript to anyone holding it as it is written. Stamped by
    // callRooms.stampRoomWordsPublic when the link or the record changes,
    // so the notice everyone in the room reads (and every guest's) never
    // has to read the record itself, which every transcript line moves.
    words_public: v.optional(v.boolean()),
    updated_at: v.number(),
  }).index("by_room", ["room_key"]),

  // A knock at a locked room. Not a request queue: TTL'd like a ring
  // (CALL_KNOCK_TTL_MS), refreshed rather than duplicated, and swept by the
  // next mutation that touches the room. Admitting is not new machinery —
  // someone inside rings the knocker with the ordinary `invite` mutation and
  // the accepted-invite grant lets them in.
  call_knocks: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    from_user: v.id("users"),
    created_at: v.number(),
  }).index("by_room", ["room_key"]),

  // A door into a huddle for people outside the team: a link somebody inside
  // made and sent. Opening it lets a stranger ask to come in, nothing more;
  // everyone who uses it still knocks and is admitted by a person in the room
  // (call_guests). A link belongs to a ROOM, not to one huddle, so a link sent
  // a day ahead of a meeting works when the meeting starts. It dies by
  // expiring or by being revoked, and a revoked link stops new knocks without
  // touching guests already admitted (removing them is its own act).
  // Never readable by token through any signed in path: the token is the
  // whole secret, so only the guest join route resolves it.
  call_guest_links: defineTable({
    room_key: v.string(),
    // Routing, never access: whose huddle this is, for the creator's lists
    // and the calls feature gate. Same rule as call_members.team_id.
    team_id: v.id("teams"),
    // Random, unguessable, the path segment of the link (guestJoinPath).
    token: v.string(),
    created_by: v.id("users"),
    // What let the creator make it: "member" (one of the room's own people)
    // or "seat" (sitting in a people or session huddle they are not a member
    // of). A link lives on its creator's standing, so every knock re-checks
    // it the same way (callGuests.linkUsable): a member who loses the room,
    // or anyone who leaves the team, takes their links with them.
    created_via: v.optional(v.union(v.literal("member"), v.literal("seat"))),
    created_at: v.number(),
    expires_at: v.number(),
    revoked_at: v.optional(v.number()),
    revoked_by: v.optional(v.id("users")),
    // How many people from this link the room has turned away or put out,
    // counted as it happens rather than by reading every row the link ever
    // made: past one, the door offers to turn the link off.
    turned_away: v.optional(v.number()),
    // When the creator was last pushed about somebody waiting at an empty
    // room on this link. Per link, not per guest: a leaked link mints new
    // guests at will, and must not page its creator once for each.
    creator_told_at: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    // Every link the room ever had, for the questions about any of them
    // (lib/callGuestAdmission.roomHasGuestLinks: a guest admitted on a link
    // since expired can still be inside).
    .index("by_room", ["room_key"])
    // The room's links still open by the clock, and only those: the stage's
    // invite panel (callGuests.listGuestLinks) subscribes to this range, so a
    // long-lived room's past links neither grow its read nor re-run it when
    // one of them is written.
    .index("by_room_expires", ["room_key", "expires_at"])
    // The creator's latest push across all their links, in one read
    // (callGuests.tellCreatorIfAlone).
    .index("by_creator_told", ["created_by", "creator_told_at"])
    // The creator's links still open by the clock, and only those: the
    // always-on "a guest is waiting" feed (callGuests.listGuestsWaiting)
    // reads this range, so a write to a long-expired link re-runs nothing.
    .index("by_creator_expires", ["created_by", "expires_at"]),

  // One outside person at one huddle's door, and then in its room. A guest
  // has no users row, so their knock and their seat cannot be call_knocks or
  // call_members rows (both hang on a user id, and every reader of those
  // tables resolves it); the guest's own row carries both, as a status
  // (CallGuestStatus in shared/contracts/callGuests.ts):
  //   waiting -> admitted | denied, admitted -> removed | left.
  // The browser holds the row id and a secret; only the secret's hash is
  // stored, so a leaked table row cannot be replayed as the guest. LiveKit
  // knows them as `guest:<this id>` (guestIdentity) under `name`, which is
  // how transcripts, faces and recordings name them.
  // Presence is a lease like a seat: the guest's client beats last_seen
  // while waiting and while in the call, and a stale beat reads as gone (a
  // knock nobody answers lapses on its own, the way call_knocks expire).
  call_guests: defineTable({
    link_id: v.id("call_guest_links"),
    room_key: v.string(),
    team_id: v.id("teams"),
    // As they typed it, cleaned by normalizeGuestName.
    name: v.string(),
    // sha256 hex of the secret the guest's browser keeps in localStorage.
    secret_hash: v.string(),
    status: callGuestStatusValidator,
    created_at: v.number(),
    // When they last asked to come in. A re-knock refreshes it, so the room
    // can tell someone is still waiting (the same rule as call_knocks).
    knocked_at: v.number(),
    last_seen: v.number(),
    // Who answered the door or put them out, and when.
    decided_by: v.optional(v.id("users")),
    decided_at: v.optional(v.number()),
    // When the guest was shown that the call is transcribed and may be
    // recorded, and went ahead. Joining requires it; the notice keeps
    // showing in the call whatever this says.
    notice_accepted_at: v.optional(v.number()),
    // WHAT they were shown when they went ahead (GuestNotice): the knock's
    // notice, then each Join pressed under a wider one. A media token is
    // refused while the room keeps more than this (authForGuestToken), so a
    // page that skips the lobby's widened notice cannot walk them into it,
    // and the row says afterwards what the guest agreed to. Absent on rows
    // from before it existed, which are held to the room as it is.
    notice_accepted: v.optional(guestNoticeValidator),
    // Why a `left` row left: they walked out, or the huddle they were let
    // into ended (an admission is for one huddle). CallGuestLeftReason.
    left_reason: v.optional(callGuestLeftReasonValidator),
    // When the link's creator was last told somebody was waiting on this
    // link at an empty room, stamped on each guest that push covered, so
    // their page says "we let them know" only when somebody was.
    creator_told_at: v.optional(v.number()),
    // When this row stopped letting the guest in (left, removed, denied).
    // The minute sweep keeps checking the media room of a running huddle for
    // a while after (by_settled), since LiveKit refreshes a connected
    // client's token by itself and only a roster check puts it out.
    settled_at: v.optional(v.number()),
    // What the guest's last beat computed for their page ("closed:quiet",
    // "admitted"), written only when it moves. getGuestState answers from the
    // clock too (a link's expiry, a huddle's grace), and a query re-runs only
    // when a row it read changes: this is that change.
    beat_view: v.optional(v.string()),
    // When this admission was last seen in the media room: a beat from a page
    // connected to it, or the roster check finding the identity in LiveKit.
    // Cleared on each admission, so a place let go with none is "not_joined"
    // rather than "lapsed" (the guest never came in, nothing dropped).
    media_seen_at: v.optional(v.number()),
    // The guest's page said it is sharing its screen, as of its last beat:
    // the edge into true starts a recording's screen file now, the same
    // nudge a teammate's call_members.sharing gives (calls.heartbeat).
    sharing: v.optional(v.boolean()),
  })
    // Every read of a room's door or roster is bounded by the lease
    // (last_seen), so rows from closed pages cost nothing to the reads that
    // run on every beat, however many a leaked link has made.
    .index("by_room_status_seen", ["room_key", "status", "last_seen"])
    .index("by_status_seen", ["status", "last_seen"])
    .index("by_settled", ["settled_at"])
    .index("by_link", ["link_id"]),

  // Which calls a guest was in: one row per guest per call record, written
  // when they are let in (or when the record starts with them inside). A
  // guest row lives across huddles on the same link, so the call it was last
  // in cannot be a field on it; the record reads its outsiders from here,
  // under the name the room let in (callGuestAdmission.noteGuestAttendance).
  call_guest_attendance: defineTable({
    transcript_id: v.id("transcripts"),
    guest_id: v.id("call_guests"),
    name: v.string(),
    joined_at: v.number(),
  })
    .index("by_transcript", ["transcript_id"])
    .index("by_guest_transcript", ["guest_id", "transcript_id"]),
};
