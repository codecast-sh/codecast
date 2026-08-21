import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveRoomAction, LiveRoomLabel } from "../calls/LiveNow";
import type { LiveRoomRow } from "../../hooks/useLiveRooms";

// ct-44995. The button on a live room must offer the gesture the server will
// accept. calls.knock refuses anyone who could just walk in, so the choice has
// to follow the viewer's own capability (can_join) and not the room's lock —
// which shuts the open door only, and never the room's own people or a guest
// holding a live grant.

const ROOM = "dm:ann:me";

function row(overrides: Partial<LiveRoomRow> = {}): LiveRoomRow {
  return {
    roomKey: ROOM,
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

const action = (r: LiveRoomRow) => renderToStaticMarkup(<LiveRoomAction row={r} />);

describe("LiveRoomAction", () => {
  test("an open room offers join", () => {
    expect(action(row())).toContain(">join<");
  });

  test("a locked room I may still enter offers join, not a knock that would fail", () => {
    const html = action(row({ locked: true, canJoin: true }));
    expect(html).toContain(">join<");
    expect(html).not.toContain(">knock<");
  });

  test("a locked room I may not enter offers knock", () => {
    const html = action(row({ locked: true, canJoin: false }));
    expect(html).toContain(">knock<");
    expect(html).not.toContain(">join<");
  });

  test("a knock already at the door waits instead of re-asking", () => {
    expect(action(row({ locked: true, canJoin: false, knocked: true }))).toContain(">knocked<");
  });

  test("the room I am sitting in offers nothing", () => {
    const html = action(row({ locked: true, canJoin: true, mine: true }));
    expect(html).toContain("you&#x27;re in");
    expect(html).not.toContain("<button");
  });

  test("the lock glyph reports the door honestly, even on a room I may enter", () => {
    const shut = renderToStaticMarkup(<LiveRoomLabel row={row({ locked: true, canJoin: true })} />);
    expect(shut).toContain('aria-label="Locked"');
    expect(renderToStaticMarkup(<LiveRoomLabel row={row()} />)).not.toContain('aria-label="Locked"');
  });
});
