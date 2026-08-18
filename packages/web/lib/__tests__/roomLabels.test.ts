import { describe, expect, test } from "bun:test";
import { describeRoom } from "../calls/roomLabels";
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
  test("a channel keeps its own room; a DM with no roster yet does not guess", () => {
    expect(chatViewRoomKey({ id: "ch1", kind: "public" }, "me")).toBe("channel:ch1");
    expect(chatViewRoomKey({ id: "chp", kind: "private", memberIds: ["me", "ann"] }, "me")).toBe("channel:chp");
    expect(chatViewRoomKey({ id: "dmx", kind: "dm" }, "me")).toBe("channel:dmx");
    expect(chatViewRoomKey({ id: "dmx", kind: "dm", dmMemberIds: ["ann"] }, "")).toBe("channel:dmx");
  });
});

describe("describeRoom", () => {
  test("a 1:1 is the other person, and needs no context line", () => {
    const d = describeRoom("dm:ann:me", store as any);
    expect(d.label).toBe("Ann Lee");
    expect(d.anchorTitle).toBeUndefined();
    expect(d.otherIds).toEqual(["ann"]);
  });
  test("a group names its people, first names past a pair", () => {
    expect(describeRoom("dm:ann:bo:me", store as any)).toEqual({
      label: "Ann & Bo",
      anchorTitle: "with Ann, Bo",
      otherIds: ["ann", "bo"],
    });
    const four = describeRoom("dm:ann:bo:cy:me", store as any);
    expect(four.label).toBe("Huddle · 4");
    expect(four.anchorTitle).toBe("with Ann, Bo, Cy");
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
});
