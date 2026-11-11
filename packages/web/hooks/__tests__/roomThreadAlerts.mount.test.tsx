// The sound for a line in the call you are in. A person's line knocks, once
// per push, never for the backlog, your own line or an event row, and never
// while the thread is open in a focused window. An agent's line plays the
// agent chime instead, every time, thread open or not.

import type { Root } from "react-dom/client";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { ThreadRow } from "../../components/calls/roomThreadModel";

let rows: ThreadRow[] | undefined;
const realNoThrow = await import("../useQueryNoThrow");
mock.module("../useQueryNoThrow", () => ({ ...realNoThrow, useQueryNoThrow: () => ({ data: rows }) }));

const knocks: string[] = [];
const realSounds = await import("../../lib/sounds");
const chimes: string[] = [];
mock.module("../../lib/sounds", () => ({
  ...realSounds,
  soundChatMessage: (id?: string) => knocks.push(id ?? ""),
  soundAgentReply: (id: string) => chimes.push(id),
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { useRoomThreadAlerts } = await import("../useRoomThreadAlerts");
const { setRoomThreadWatching } = await import("../../lib/calls/roomThreadSeen");
const { useRoomThreadUnread } = await import("../useRoomThreadUnread");

afterAll(() => {
  mock.module("../useQueryNoThrow", () => realNoThrow);
  mock.module("../../lib/sounds", () => realSounds);
  closeDomWindow(dom);
  restoreGlobals();
});

let n = 0;
const row = (at: number, over: Partial<ThreadRow> = {}): ThreadRow => ({
  _id: `m${n++}`, user_id: "u2", user_name: "Ada", text: "hi", at, mine: false, agent: null, event: null, ...over,
});
const agent = { conversation_id: "c1", short_id: "jx7a", title: "Ember", agent_type: "claude_code" };

function Probe() {
  useRoomThreadAlerts();
  return null;
}

let root: Root;
let room = 0;
async function enter(backlog: ThreadRow[]) {
  const roomKey = `room:alerts-${room++}`;
  useInboxStore.setState((s: any) => ({ call: { ...s.call, phase: "connected", roomKey } }));
  rows = backlog;
  root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
  await act(async () => root.render(<Probe />));
  return roomKey;
}
async function land(next: ThreadRow[]) {
  rows = next;
  await act(async () => root.render(<Probe />));
}

describe("the call chat knock", () => {
  beforeEach(() => {
    knocks.length = 0;
    chimes.length = 0;
  });

  test("the backlog is silent; a new line from a person knocks once", async () => {
    const backlog = [row(1), row(2)];
    await enter(backlog);
    expect(knocks).toEqual([]);
    const line = row(3);
    await land([...backlog, line]);
    expect(knocks).toEqual([line._id]);
    await act(async () => root.unmount());
  });

  test("an agent's answer chimes instead of knocking, once per push, for the newest agent line", async () => {
    await enter([row(1)]);
    const a = row(2), b = row(3, { agent });
    await land([row(1), a, b]);
    expect(chimes).toEqual([b._id]);
    expect(knocks).toEqual([]);
    await act(async () => root.unmount());
  });

  test("an agent's answer chimes even while the thread is open and watched", async () => {
    const roomKey = await enter([row(1)]);
    setRoomThreadWatching(roomKey, true);
    const b = row(2, { agent });
    await land([row(1), b]);
    expect(chimes).toEqual([b._id]);
    setRoomThreadWatching(roomKey, false);
    await act(async () => root.unmount());
  });

  test("my own lines and event rows are silent", async () => {
    await enter([row(1)]);
    await land([row(1), row(2, { mine: true }), row(3, { event: "agent_joined" as any, agent })]);
    expect(knocks).toEqual([]);
    expect(chimes).toEqual([]);
    await act(async () => root.unmount());
  });

  test("silent while the thread is open in a focused window", async () => {
    const roomKey = await enter([row(1)]);
    setRoomThreadWatching(roomKey, true);
    await land([row(1), row(2)]);
    expect(knocks).toEqual([]);
    setRoomThreadWatching(roomKey, false);
    const next = row(3);
    await land([row(1), row(2), next]);
    expect(knocks).toEqual([next._id]);
    await act(async () => root.unmount());
  });
});

describe("the stage with the thread open", () => {
  // Nothing is unread while the thread is open, so the peek over the video
  // used to stay down and an agent's answer landed only as a line in the
  // rail, where nobody watching faces saw it.
  let seen: ThreadRow | null = null;
  function OpenRail({ roomKey }: { roomKey: string }) {
    seen = useRoomThreadUnread(roomKey, true).arrived;
    return null;
  }

  test("an agent's answer that lands is handed to the peek; the backlog never is", async () => {
    const roomKey = `room:open-${room++}`;
    const old = row(1, { agent });
    rows = [old];
    const r = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
    await act(async () => r.render(<OpenRail roomKey={roomKey} />));
    expect(seen).toBeNull();
    const person = row(2);
    rows = [old, person];
    await act(async () => r.render(<OpenRail roomKey={roomKey} />));
    expect(seen).toBeNull();
    const answer = row(3, { agent });
    rows = [old, person, answer];
    await act(async () => r.render(<OpenRail roomKey={roomKey} />));
    expect(seen?._id).toBe(answer._id);
    await act(async () => r.unmount());
  });
});
