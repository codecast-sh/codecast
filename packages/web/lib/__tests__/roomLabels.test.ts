import { describe, expect, test } from "bun:test";
import { describeRoom, describeRoomLive } from "../calls/roomLabels";
import { chatViewRoomKey } from "../chatViews";

// One room, one name, everywhere: the dock pill, the stage header, the ring
// toast's context line and every start button read the room through
// describeRoom, and every chat surface picks the key through chatViewRoomKey.

const store = {
  currentUser: { _id: "me" },
  teamMembers: [
    { _id: "me", name: "Ashot P" },
    { _id: "ann", name: "Ann Lee" },
    { _id: "bo", name: "Bo Diddley" },
    { _id: "cy", name: "Cy" },
  ],
  chatChannels: {
    ch1: { _id: "ch1", name: "design", kind: "public" },
    dm1: { _id: "dm1", name: "", kind: "dm" },
  },
  chatRail: [{ channel_id: "dm1", member_ids: ["me", "ann", "bo"] }],
  conversations: { sess1: { _id: "conv1", title: "Fix the auth race" } },
  sessions: {},
};

describe("chatViewRoomKey", () => {
  test("a 1:1 DM and the avatar-bar ring share one room", () => {
    expect(chatViewRoomKey({ id: "dm0", kind: "dm", dmMemberIds: ["ann"] }, "me")).toBe("dm:ann:me");
  });
  test("a group thread huddles in the room of its members", () => {
    expect(chatViewRoomKey({ id: "dm1", kind: "dm", dmMemberIds: ["bo", "ann"] }, "me")).toBe("dm:ann:bo:me");
  });
  test("a group thread with a departed member falls back to its channel room", () => {
    const teammates = [{ _id: "me" }, { _id: "ann" }];
    // bo left the team: the member-set room would be refused server-side.
    expect(chatViewRoomKey({ id: "dm1", kind: "dm", dmMemberIds: ["ann", "bo"] }, "me", teammates)).toBe("channel:dm1");
    // Everyone still present: the member-set room as usual.
    expect(chatViewRoomKey({ id: "dm1", kind: "dm", dmMemberIds: ["ann"] }, "me", teammates)).toBe("dm:ann:me");
  });
  test("a channel keeps its own room; a DM with no roster yet does not guess", () => {
    expect(chatViewRoomKey({ id: "ch1", kind: "public" }, "me")).toBe("channel:ch1");
    expect(chatViewRoomKey({ id: "chp", kind: "private", memberIds: ["me", "ann"] }, "me")).toBe("channel:chp");
    expect(chatViewRoomKey({ id: "dmx", kind: "dm" }, "me")).toBe("channel:dmx");
    expect(chatViewRoomKey({ id: "dmx", kind: "dm", dmMemberIds: ["ann"] }, "")).toBe("channel:dmx");
  });
});

describe("describeRoom", () => {
  test("a 1:1 is the other person; people rooms carry no context line (the server derives it per recipient)", () => {
    const d = describeRoom("dm:ann:me", store as any);
    expect(d.label).toBe("Ann Lee");
    expect(d.anchorTitle).toBeUndefined();
    expect(d.otherIds).toEqual(["ann"]);
  });
  test("a group reads exactly like its chat thread: first names, comma joined", () => {
    const three = describeRoom("dm:ann:bo:me", store as any);
    expect(three.label).toBe("Ann, Bo");
    expect(three.otherIds).toEqual(["ann", "bo"]);
    expect(describeRoom("dm:ann:bo:cy:me", store as any).label).toBe("Ann, Bo, Cy");
  });
  test("guests in the live roster join the name: the key says Bob, the room says Bob and Cy", () => {
    const withGuest = {
      ...store,
      callOccupancy: { "dm:ann:me": [{ user_id: "ann" }, { user_id: "cy" }, { user_id: "me" }] },
    };
    expect(describeRoom("dm:ann:me", withGuest as any).label).toBe("Ann, Cy");
  });
  test("a channel is its hash name; a DM channel room reads like the rail", () => {
    expect(describeRoom("channel:ch1", store as any)).toEqual({ label: "#design", anchorTitle: "#design", otherIds: [] });
    expect(describeRoom("channel:dm1", store as any).label).toBe("Ann, Bo");
    expect(describeRoom("channel:unknown", store as any).label).toBe("Channel huddle");
  });
  test("a session huddle is about its title", () => {
    expect(describeRoom("session:conv1", store as any)).toEqual({
      label: "Fix the auth race",
      anchorTitle: "about: Fix the auth race",
      otherIds: [],
    });
    expect(describeRoom("session:nope", store as any).label).toBe("Session huddle");
  });
  test("unknown or absent keys fall back honestly", () => {
    expect(describeRoom(null, store as any).label).toBe("Huddle");
    expect(describeRoom("room:x", store as any).label).toBe("Huddle");
  });

  // Open rooms: a live huddle lists for the whole team, but a session room
  // whose conversation the viewer cannot see must not carry its title into
  // that list. The room stays joinable; only the NAME redacts.
  test("a redacted room is 'a huddle', and nothing about it is looked up", () => {
    const leaky = {
      ...store,
      conversations: { conv1: { _id: "conv1", title: "Acquisition terms" } },
    };
    const d = describeRoom("session:conv1", leaky as any, { redacted: true });
    expect(d).toEqual({ label: "a huddle", otherIds: [] });
    expect(d.anchorTitle).toBeUndefined();
  });

  // The live-rooms list names rooms this client never pulled into its store
  // (another team's channel, a session it has not opened). The server sends
  // the title; the store still wins when it has one.
  // The in-room path. Under the open door a teammate can SIT in a session room
  // whose conversation they cannot see, and the dock and the stage header name
  // the room they are in — so the listing's redaction has to govern that name
  // too, or walking in would reveal what the list withheld.
  test("a redacted room keeps its name hidden from the people inside it", () => {
    const leaky = {
      ...store,
      // The viewer's cache happens to hold the conversation (stale IDB, an
      // earlier membership, an incidental sync).
      conversations: { conv1: { _id: "conv1", title: "Acquisition terms" } },
      liveRooms: [{ room_key: "session:conv1", redacted: true }],
    };
    expect(describeRoomLive("session:conv1", leaky as any).label).toBe("a huddle");
    // Same store, same room, membership restored: the name comes back.
    const visible = { ...leaky, liveRooms: [{ room_key: "session:conv1", redacted: false }] };
    expect(describeRoomLive("session:conv1", visible as any).label).toBe("Acquisition terms");
  });

  test("a room the live list does not know is named the ordinary way", () => {
    // A ring toast names a room nobody has joined yet: no live row, no ruling.
    expect(describeRoomLive("session:conv1", store as any).label).toBe("Fix the auth race");
    expect(describeRoomLive("channel:unknown", { ...store, liveRooms: [
      { room_key: "channel:unknown", title: "ops" },
    ] } as any).label).toBe("#ops");
  });

  test("the server's title names a room the store has never seen", () => {
    expect(describeRoom("channel:unknown", store as any, { serverTitle: "ops" })).toEqual({
      label: "#ops",
      anchorTitle: "#ops",
      otherIds: [],
    });
    expect(describeRoom("session:nope", store as any, { serverTitle: "Ship it" }).label).toBe("Ship it");
    expect(describeRoom("channel:ch1", store as any, { serverTitle: "stale" }).label).toBe("#design");
    expect(describeRoom("session:conv1", store as any, { serverTitle: "stale" }).label).toBe("Fix the auth race");
  });
});
