import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveRoomRow } from "../../hooks/useLiveRooms";

let ROOMS: LiveRoomRow[] = [];

mock.module("../../hooks/useLiveRooms", () => ({
  useLiveRooms: () => ROOMS,
}));
// Stubbed to the module's full export shape, not just the one export this test
// renders. `mock.module` is process-global, so a substitution missing an export
// breaks whichever file links it next: ConversationView imports
// `SessionHuddleButton` from here, and got a link-time SyntaxError it never
// asked for. Spreading the real module instead is not an option — it pulls in
// lib/calls/callManager, the live WebRTC stack this test exists to stay out of.
mock.module("../calls/OccupancyChip", () => ({
  Facepile: () => null,
  OccupancyChip: () => null,
  HuddleButton: () => null,
  SessionHuddleButton: () => null,
}));

const { LiveNowRail } = await import("../calls/LiveNow");

function room(overrides: Partial<LiveRoomRow> = {}): LiveRoomRow {
  return {
    roomKey: "dm:ann:me",
    label: "Ann",
    locked: false,
    canJoin: true,
    redacted: false,
    members: [{ user_id: "ann", user_name: "Ann" }],
    mine: false,
    knocked: false,
    ...overrides,
  };
}

const rail = (rooms: LiveRoomRow[], isNarrow: boolean) => {
  ROOMS = rooms;
  return renderToStaticMarkup(<LiveNowRail isNarrow={isNarrow} />);
};

describe("LiveNowRail", () => {
  test("an empty rail renders nothing — a room nobody sits in does not exist", () => {
    expect(rail([], false)).toBe("");
    expect(rail([], true)).toBe("");
  });

  test("the icon rail offers a button for a room you may enter", () => {
    const html = rail([room()], true);
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Join Ann"');
  });

  test("the icon rail offers a knock where the lock shuts you out", () => {
    expect(rail([room({ locked: true, canJoin: false })], true)).toContain(
      'aria-label="Knock at Ann"',
    );
  });

  test("the room you are sitting in offers its existing huddle window", () => {
    const html = rail([room({ mine: true })], true);
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Show Ann"');
    expect(html).toContain('title="Ann — show huddle"');
  });

  test("the wide row carries no role of its own — the button inside it is the gesture", () => {
    const html = rail([room()], false);
    expect(html).not.toContain('role="button"');
    expect(html).toContain('aria-label="Join Ann"');
  });

  test("the live dot is decoration, not something to announce", () => {
    expect(rail([room()], false)).toContain('aria-hidden="true"');
  });
});
