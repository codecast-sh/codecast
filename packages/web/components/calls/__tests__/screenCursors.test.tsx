import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomEvent } from "livekit-client";
import { replaceGlobals } from "../../../test-helpers/globals";

import { closeDomWindow } from "../../../test-helpers/domGlobals";
// The room is replaced only for getRoom (the local identity); everything else
// stays real, so other files that spread this module keep their exports.
const realCallManager = { ...(await import("../../../lib/calls/callManager")) };
mock.module("../../../lib/calls/callManager", () => ({
  ...realCallManager,
  getRoom: () => ({ localParticipant: { identity: "u-me" } }),
}));

const { bindCallCursors, encodeCursorMessage, resetCallCursors } = await import("../../../lib/calls/callCursors");
const { ScreenCursors } = await import("../ScreenCursors");

const dom = new JSDOM("<!doctype html><html><body></body></html>");
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(dom.window as any).ResizeObserver = TestResizeObserver;
// A 400 by 225 tile (16:9) showing a 1600 by 900 share: the content rect is the whole tile.
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 400, height: 225, right: 400, bottom: 225, x: 0, y: 0, toJSON() {} } as DOMRect;
};
Object.defineProperty(dom.window.HTMLVideoElement.prototype, "videoWidth", { get: () => 1600 });
Object.defineProperty(dom.window.HTMLVideoElement.prototype, "videoHeight", { get: () => 900 });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: TestResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
  mock.module("../../../lib/calls/callManager", () => realCallManager);
});

// A room that only remembers its handlers, so the test can deliver a packet
// the way LiveKit would.
class FakeRoom {
  handlers = new Map<string, Function[]>();
  on(event: string, fn: Function) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
}

const tile = { key: "u-ann:screen:TR_1", identity: "u-ann", name: "Ann Lee", isLocal: false, kind: "screen" as const, track: { sid: "TR_1" } as any };

function Tile() {
  const boxRef = { current: null as HTMLDivElement | null };
  const videoRef = { current: null as HTMLVideoElement | null };
  return (
    <div ref={(el) => { boxRef.current = el; }}>
      <video ref={(el) => { videoRef.current = el; }} />
      <ScreenCursors tile={tile} boxRef={boxRef} videoRef={videoRef} />
    </div>
  );
}

beforeAll(() => resetCallCursors());

test("a teammate's packet over this share draws their arrow at the mapped pixel, with their name; my own never draws", async () => {
  const room = new FakeRoom();
  bindCallCursors(room as any);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<Tile />));
    expect(container.querySelector("[data-sv-screen-cursors]")).toBeNull();

    await act(() => {
      room.emit(RoomEvent.DataReceived, encodeCursorMessage({ t: "cursor", sid: "TR_1", nx: 0.5, ny: 0.5, at: Date.now() }), { identity: "u-bob", name: "Bob Stone" }, undefined, "cursor");
    });
    const cursor = container.querySelector("[data-sv-screen-cursor='u-bob']") as HTMLElement;
    expect(cursor).not.toBeNull();
    expect(cursor.style.transform).toBe("translate(200px, 112.5px)");
    expect(container.querySelector("[data-sv-cursor-label]")?.textContent).toBe("Bob");

    // Another share's cursor and my own echo stay off this tile.
    await act(() => {
      room.emit(RoomEvent.DataReceived, encodeCursorMessage({ t: "cursor", sid: "TR_other", nx: 0.1, ny: 0.1, at: Date.now() }), { identity: "u-cy", name: "Cy" }, undefined, "cursor");
      room.emit(RoomEvent.DataReceived, encodeCursorMessage({ t: "cursor", sid: "TR_1", nx: 0.1, ny: 0.1, at: Date.now() }), { identity: "u-me", name: "Me" }, undefined, "cursor");
    });
    expect(container.querySelectorAll("[data-sv-screen-cursor]").length).toBe(1);

    // A gone packet clears it at once.
    await act(() => {
      room.emit(RoomEvent.DataReceived, encodeCursorMessage({ t: "cursor", sid: "TR_1", gone: true, at: Date.now() }), { identity: "u-bob", name: "Bob Stone" }, undefined, "cursor");
    });
    expect(container.querySelector("[data-sv-screen-cursors]")).toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
