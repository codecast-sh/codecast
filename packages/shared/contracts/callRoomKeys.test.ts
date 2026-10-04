import { describe, expect, test } from "bun:test";
import { callDisplayTitle } from "./callRoomKeys";

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

  test("a place name of the wrong kind is ignored", () => {
    expect(callDisplayTitle({ room_key: "dm:a:b" }, { sessionTitle: "Fix auth" })).toBe("Untitled huddle");
  });
});
