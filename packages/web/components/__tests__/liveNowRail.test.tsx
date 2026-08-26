import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveRoomRow } from "../../hooks/useLiveRooms";

// ct-44931 polish round 1. The icon rail (the collapsed sidebar) rendered a
// <button> for every live room including the one you are already sitting in,
// and that button's handler returned immediately. A keyboard reaching it got a
// tab stop that answers nothing, and a screen reader announced a control that
// does not exist. The room you are in is now a plain span.

let ROOMS: LiveRoomRow[] = [];

mock.module("../../hooks/useLiveRooms", () => ({
  useLiveRooms: () => ROOMS,
}));
mock.module("../../lib/calls/callManager", () => ({
  joinCall: () => {},
  knockRoom: () => {},
}));
mock.module("../calls/OccupancyChip", () => ({
  Facepile: () => null,
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

  test("the room you are sitting in is not a control", () => {
    const html = rail([room({ mine: true })], true);
    expect(html).not.toContain("<button");
    expect(html).toContain("you&#x27;re in");
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
