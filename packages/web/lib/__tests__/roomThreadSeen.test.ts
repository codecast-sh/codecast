// What the call's chat badge counts: lines from someone else, a person or an
// agent, that landed after the viewer last had the thread open. Never their
// own lines, never an event, never the backlog of a room they walk into, and
// nothing while the thread is open in a focused window.

import { describe, expect, test } from "bun:test";
import type { ThreadRow } from "../../components/calls/roomThreadModel";
import { countUnread, getRoomThreadSeen, markRoomThreadSeen, setRoomThreadWatching, unreadArrivals } from "../calls/roomThreadSeen";

let n = 0;
function row(at: number, over: Partial<ThreadRow> = {}): ThreadRow {
  return { _id: `r${n++}`, user_id: "u2", user_name: "Ada", text: "hi", at, mine: false, agent: null, event: null, ...over };
}
const agent = { conversation_id: "c1", short_id: "jx7a", title: "Ember", agent_type: "claude_code" };

describe("room thread unread", () => {
  test("the backlog of a room walked into is seen, later lines count", () => {
    const room = "room:backlog";
    const backlog = [row(1), row(2)];
    markRoomThreadSeen(room, backlog, false);
    expect(countUnread(backlog, getRoomThreadSeen(room))).toBe(0);
    const later = [...backlog, row(3), row(4, { agent })];
    markRoomThreadSeen(room, later, false);
    expect(countUnread(later, getRoomThreadSeen(room))).toBe(2);
  });

  test("own lines and events never count", () => {
    const room = "room:mine";
    markRoomThreadSeen(room, [row(1)], false);
    const rows = [row(1), row(2, { mine: true }), row(3, { event: "agent_joined" as any, agent })];
    expect(countUnread(rows, getRoomThreadSeen(room))).toBe(0);
  });

  test("opening the thread reads everything; watching counts nothing", () => {
    const room = "room:open";
    markRoomThreadSeen(room, [row(1)], false);
    const rows = [row(1), row(2), row(3)];
    expect(countUnread(rows, getRoomThreadSeen(room))).toBe(2);
    markRoomThreadSeen(room, rows, true);
    expect(countUnread(rows, getRoomThreadSeen(room))).toBe(0);
    const more = [...rows, row(4)];
    setRoomThreadWatching(room, true);
    expect(countUnread(more, getRoomThreadSeen(room))).toBe(0);
    setRoomThreadWatching(room, false);
    expect(countUnread(more, getRoomThreadSeen(room))).toBe(1);
  });

  test("the newest unread arrival says whether an agent sent it", () => {
    const room = "room:latest";
    markRoomThreadSeen(room, [row(1)], false);
    const answered = [row(1), row(2), row(3, { agent }), row(4, { mine: true })];
    expect(unreadArrivals(answered, getRoomThreadSeen(room)).at(-1)?.agent?.title).toBe("Ember");
    const followed = [...answered, row(5)];
    expect(unreadArrivals(followed, getRoomThreadSeen(room)).at(-1)?.agent).toBeNull();
  });

  test("an unknown room counts nothing until it has been seen once", () => {
    expect(countUnread([row(1)], getRoomThreadSeen("room:never"))).toBe(0);
  });
});
