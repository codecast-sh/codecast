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
    expect(callDisplayTitle({ room_key: "rec:1fad0bfc-1234" }, { sessionTitle: "x" })).toBe("Untitled recording");
    expect(callDisplayTitle({ room_key: "dm:a:b" }, { untitled: "Typed huddle, nothing said" })).toBe("Typed huddle, nothing said");
  });

  test("a place name of the wrong kind is ignored", () => {
    expect(callDisplayTitle({ room_key: "dm:a:b" }, { sessionTitle: "Fix auth" })).toBe("Untitled huddle");
  });
});
