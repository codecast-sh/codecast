// useDebounce arms a timer only when there is something to settle. A timer
// armed on mount set the same value 250ms later; landing just after a
// keystroke's commit, that same-value set re-rendered the whole composer, a
// second commit on one key (composerTypingBudget, flaky on CI).

import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { useDebounce } = await import("../useDebounce");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const DELAY = 40;
const realSetTimeout = globalThis.setTimeout;
let armed = 0;
const seen: string[] = [];
function Probe({ value }: { value: string }) {
  seen.push(useDebounce(value, DELAY));
  return null;
}

let root: Root;
beforeEach(() => {
  armed = 0;
  seen.length = 0;
  (globalThis as any).setTimeout = ((fn: () => void, ms?: number) => {
    if (ms === DELAY) armed++;
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout;
  root = createRoot(dom.window.document.createElement("div"));
});
afterEach(async () => {
  (globalThis as any).setTimeout = realSetTimeout;
  await act(async () => root.unmount());
});

const wait = (ms: number) => act(async () => { await new Promise((r) => realSetTimeout(r, ms)); });

test("mounting arms no timer and renders once", async () => {
  await act(async () => root.render(<Probe value="" />));
  await wait(DELAY * 3);
  expect({ armed, renders: seen.length }).toEqual({ armed: 0, renders: 1 });
});

test("a changed value settles after the delay", async () => {
  await act(async () => root.render(<Probe value="a" />));
  await act(async () => root.render(<Probe value="ab" />));
  expect(seen.at(-1)).toBe("a");
  await wait(DELAY * 3);
  expect(seen.at(-1)).toBe("ab");
  expect(armed).toBe(1);
});

test("a value typed back to the debounced one before the delay leaves nothing pending", async () => {
  await act(async () => root.render(<Probe value="a" />));
  await act(async () => root.render(<Probe value="ab" />));
  await act(async () => root.render(<Probe value="a" />));
  const renders = seen.length;
  await wait(DELAY * 3);
  expect({ armed, renders: seen.length, value: seen.at(-1) }).toEqual({ armed: 1, renders, value: "a" });
});
