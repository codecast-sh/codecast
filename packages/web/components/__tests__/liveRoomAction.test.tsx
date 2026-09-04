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

  test("the room I am sitting in offers its existing huddle window", () => {
    const html = action(row({ locked: true, canJoin: true, mine: true }));
    expect(html).toContain("<button");
    expect(html).toContain("open huddle");
    expect(html).toContain('aria-label="Show Ann"');
    expect(html).toContain('title="Show the huddle window"');
  });

  test("the lock glyph reports the door honestly, even on a room I may enter", () => {
    const shut = renderToStaticMarkup(<LiveRoomLabel row={row({ locked: true, canJoin: true })} />);
    expect(shut).toContain('aria-label="Locked"');
    expect(renderToStaticMarkup(<LiveRoomLabel row={row()} />)).not.toContain('aria-label="Locked"');
  });
});

// ct-44931 polish round 1. The cluster was mouse-only: the wide row carried
// role="button" with no tab stop and no key handler (and wrapped a real button,
// which is invalid ARIA), and the icon rail rendered a button for the room you
// are already sitting in whose handler returned immediately. The gesture now
// belongs to a real button in every case, and the row keeps only its mouse
// convenience.

describe("Live now is reachable by keyboard, and says what it reaches", () => {
  test("join carries the room, not just the verb", () => {
    expect(action(row({ label: "Ann" }))).toContain('aria-label="Join Ann"');
  });

  test("knock carries the room too", () => {
    expect(action(row({ locked: true, canJoin: false, label: "#design" }))).toContain(
      'aria-label="Knock at #design"',
    );
  });

  test("a redacted huddle still names itself the way the row does", () => {
    expect(action(row({ redacted: true, label: "a huddle" }))).toContain(
      'aria-label="Join a huddle"',
    );
  });

  test("every gesture is a real button, so tab reaches it", () => {
    for (const r of [row(), row({ locked: true, canJoin: false }), row({ mine: true })]) {
      expect(action(r)).toContain("<button");
    }
  });

  test("a pending knock renders no control until I am in the room", () => {
    const waiting = row({ locked: true, canJoin: false, knocked: true });
    expect(action(waiting)).not.toContain("<button");
    expect(action({ ...waiting, mine: true })).toContain('aria-label="Show Ann"');
  });
});
