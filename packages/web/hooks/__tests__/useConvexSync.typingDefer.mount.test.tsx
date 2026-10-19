// A coalesced feed (the inbox) waits for a pause in typing before it applies,
// and never past its cap. Each inbox apply re-places every session and wakes
// every subscriber; landing one between two keystrokes is what made the
// composer feel slow on a busy machine.

import type { Root } from "react-dom/client";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

mock.restore();
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }) }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { useConvexSync } = await import(`${import.meta.dir}/../useConvexSync.ts?fresh-typing`);
const { noteInputForTests } = await import("../../lib/inputQuiet");

afterAll(() => {
  mock.module("convex/react", () => convexReact);
  closeDomWindow(dom);
  restoreGlobals();
});

const applied: Array<{ value: number; at: number }> = [];
function Feed({ value }: { value: number }) {
  useConvexSync(value, (v: number) => { applied.push({ value: v, at: Date.now() }); }, { coalesceMs: 50 });
  return null;
}

let root: Root;
beforeEach(() => {
  applied.length = 0;
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  root = createRoot(host);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("applies after its window when nobody is typing", async () => {
  const start = Date.now();
  await act(async () => { root.render(<Feed value={1} />); });
  await act(async () => { await sleep(120); });
  expect(applied.map((a) => a.value)).toEqual([1]);
  expect(applied[0].at - start).toBeLessThan(400);
  await act(async () => { root.unmount(); });
});

test("waits for a pause in typing, then applies the newest value", async () => {
  noteInputForTests();
  const typing = setInterval(noteInputForTests, 60);
  await act(async () => { root.render(<Feed value={1} />); });
  await act(async () => { await sleep(300); });
  expect(applied).toEqual([]);
  await act(async () => { root.render(<Feed value={2} />); });
  clearInterval(typing);
  const stoppedAt = Date.now();
  await act(async () => { await sleep(600); });
  expect(applied.map((a) => a.value)).toEqual([2]);
  expect(applied[0].at - stoppedAt).toBeGreaterThanOrEqual(300);
  await act(async () => { root.unmount(); });
});

test("never waits past its cap while typing goes on", async () => {
  const start = Date.now();
  noteInputForTests();
  const typing = setInterval(noteInputForTests, 60);
  await act(async () => { root.render(<Feed value={7} />); });
  await act(async () => { await sleep(2200); });
  clearInterval(typing);
  expect(applied.map((a) => a.value)).toEqual([7]);
  expect(applied[0].at - start).toBeLessThan(1500 + 50 + 450);
  await act(async () => { root.unmount(); });
});
