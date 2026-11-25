// A composer open on a conversation the server refuses (deleted, or access
// lost) kept its presence heartbeat running: one tab sent updatePresence every
// 3s and prod answered NOT_FOUND ~1,200 times an hour. The presence query is
// refused by the same gate, so its error stops the broadcast.

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

let presence: { data?: unknown[]; error?: Error } = {};
const realNoThrow = await import("../useQueryNoThrow");
mock.module("../useQueryNoThrow", () => ({ ...realNoThrow, useQueryNoThrow: () => ({ ...presence, retry: () => {} }) }));

const updates: unknown[] = [];
const removes: unknown[] = [];
const convexReact = await import("convex/react");
const { getFunctionName } = await import("convex/server");
mock.module("convex/react", () => ({
  ...convexReact,
  useMutation: (ref: any) => {
    const sink = getFunctionName(ref).endsWith("removePresence") ? removes : updates;
    return (args: unknown) => { sink.push(args); return Promise.resolve(); };
  },
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { useDocPresence } = await import("../useDocPresence");

afterAll(() => {
  mock.module("../useQueryNoThrow", () => realNoThrow);
  mock.module("convex/react", () => convexReact);
  closeDomWindow(dom);
  restoreGlobals();
});

beforeEach(() => { updates.length = 0; removes.length = 0; });

function mountComposer() {
  function Probe() {
    useDocPresence({ docId: "compose:abc", draftText: "hi", enabled: true, forceBroadcast: true });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return root;
}

test("a refused id writes no presence", () => {
  presence = { error: new Error('{"code":"NOT_FOUND"}') };
  const root = mountComposer();
  act(() => root.unmount());
  expect(updates).toEqual([]);
  expect(removes).toEqual([]);
});

test("an accepted id announces itself and leaves on unmount", () => {
  presence = { data: [] };
  const root = mountComposer();
  act(() => root.unmount());
  expect(updates.length).toBeGreaterThan(0);
  expect(removes).toEqual([{ doc_id: "compose:abc" }]);
});
