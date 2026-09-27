// The knock for a line typed in the call you are in. It sounds for a line
// from someone else, a person or an agent in the room, that arrives while you
// are in the call: once per push, never for the backlog of a room you walk
// into, never for your own line or an event row, and never while the thread
// is open in a focused window where the line is read as it lands.

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
mock.module("../../lib/sounds", () => ({ ...realSounds, soundChatMessage: (id?: string) => knocks.push(id ?? "") }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { useRoomThreadAlerts } = await import("../useRoomThreadAlerts");
const { setRoomThreadWatching } = await import("../../lib/calls/roomThreadSeen");

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

  test("an agent's answer knocks; several lines in one push knock once, for the newest", async () => {
    await enter([row(1)]);
    const a = row(2), b = row(3, { agent });
    await land([row(1), a, b]);
    expect(knocks).toEqual([b._id]);
    await act(async () => root.unmount());
  });

  test("my own lines and event rows are silent", async () => {
    await enter([row(1)]);
    await land([row(1), row(2, { mine: true }), row(3, { event: "agent_joined" as any, agent })]);
    expect(knocks).toEqual([]);
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
