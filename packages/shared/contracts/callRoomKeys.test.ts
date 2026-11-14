import { describe, expect, test } from "bun:test";
import { callDisplayTitle, callLength, isMeetRoomKey, isRecRoomKey, isRoomlessKey, meetRoomKey, parseRoomKey } from "./callRoomKeys";

describe("callDisplayTitle", () => {
  test("a call's own title wins over every place name", () => {
    expect(callDisplayTitle({ title: " Launch review ", room_key: "session:abc" }, { sessionTitle: "Fix auth" })).toBe("Launch review");
  });

  test("an untitled call is named by where it happened, never by its key", () => {
    expect(callDisplayTitle({ room_key: "session:abc" }, { sessionTitle: "Fix auth" })).toBe("Huddle in Fix auth");
    expect(callDisplayTitle({ room_key: "dm:a:b" }, { peerName: "Ann" })).toBe("Call with Ann");
    expect(callDisplayTitle({ room_key: "channel:c1" }, { channelName: "design" })).toBe("Huddle in #design");
    // A DM thread that huddles in its channel room is a call with its people.
    expect(callDisplayTitle({ room_key: "channel:c1" }, { peerName: "Ann, Bo" })).toBe("Call with Ann, Bo");
  });

  test("with nothing known it falls back to a plain word", () => {
    expect(callDisplayTitle({ title: null, room_key: "session:abc" })).toBe("Untitled huddle");
    expect(callDisplayTitle({ room_key: "dm:a:b" })).toBe("Untitled huddle");
    expect(callDisplayTitle({ room_key: "rec:1fad0bfc-1234" }, { sessionTitle: "x" })).toBe("Untitled voice note");
    expect(callDisplayTitle({ room_key: "dm:a:b" }, { untitled: "Typed huddle, nothing said" })).toBe("Typed huddle, nothing said");
  });

  test("an untitled call with no place is named after its people, besides the reader", () => {
    const people = [
      { id: "me", name: "Ann Lee" },
      { id: "u2", name: "Cam Ortiz" },
    ];
    expect(callDisplayTitle({ room_key: "channel:c1", participants: people }, { viewerId: "me" })).toBe("Huddle with Cam");
    expect(callDisplayTitle({ room_key: "channel:c1", participants: people })).toBe("Huddle with Ann, Cam");
    const many = ["a@x.org", "Bo", "Cy", "Di", "Ed"].map((name, i) => ({ id: `u${i}`, name }));
    expect(callDisplayTitle({ room_key: "channel:c1", participants: many })).toBe("Huddle with a, Bo, Cy and 2 more");
    // The place still wins, and the reader alone names nothing.
    expect(callDisplayTitle({ room_key: "channel:c1", participants: people }, { channelName: "design" })).toBe("Huddle in #design");
    expect(callDisplayTitle({ room_key: "channel:c1", participants: [people[0]] }, { viewerId: "me" })).toBe("Untitled huddle");
    expect(callDisplayTitle({ room_key: "rec:1fad0bfc-1234", participants: people })).toBe("Untitled voice note");
  });

  test("a meeting bot's call is named after the people it heard", () => {
    const people = [
      { id: "me", name: "Ann Lee" },
      { id: "recall:b1:2", name: "Cam Ortiz" },
    ];
    expect(callDisplayTitle({ room_key: "meet:1fad0bfc-1234", participants: people }, { viewerId: "me" })).toBe("Meeting with Cam");
    expect(callDisplayTitle({ room_key: "meet:1fad0bfc-1234" })).toBe("Untitled meeting");
  });

  test("a place name of the wrong kind is ignored", () => {
    expect(callDisplayTitle({ room_key: "dm:a:b" }, { sessionTitle: "Fix auth" })).toBe("Untitled huddle");
  });
});

describe("callLength", () => {
  test("seconds under a minute, minutes, then hours with a space", () => {
    expect(callLength(0, 31_000)).toBe("31s");
    expect(callLength(0, 2_000)).toBe("2s");
    expect(callLength(0, 200)).toBe("1s");
    expect(callLength(0, 59_600)).toBe("1m");
    expect(callLength(0, 12 * 60_000 + 20_000)).toBe("12m");
    expect(callLength(0, 74 * 60_000)).toBe("1h 14m");
    expect(callLength(0, 120 * 60_000)).toBe("2h");
    expect(callLength(0, null)).toBe("live");
  });
});

describe("meet room keys", () => {
  test("a meeting key parses, and is roomless without being a recording", () => {
    const key = meetRoomKey("1fad0bfc-1234");
    expect(parseRoomKey(key)).toEqual({ kind: "meet", meetId: "1fad0bfc-1234" });
    expect(isMeetRoomKey(key)).toBe(true);
    expect(isRoomlessKey(key)).toBe(true);
    expect(isRecRoomKey(key)).toBe(false);
    expect(isRoomlessKey("rec:1fad0bfc-1234")).toBe(true);
    expect(isRoomlessKey("session:abc")).toBe(false);
  });

  test("a meeting key cannot smuggle separators or length", () => {
    expect(parseRoomKey("meet:a:b")).toBeNull();
    expect(parseRoomKey("meet:short")).toBeNull();
    expect(parseRoomKey(`meet:${"a".repeat(65)}`)).toBeNull();
  });
});
