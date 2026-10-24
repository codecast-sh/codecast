import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><body></body>");
(globalThis as any).window = dom.window;
const { hoverFocus, keyboardOwnsFocus } = await import("./focusSource");
afterAll(() => { delete (globalThis as any).window; closeDomWindow(dom); });

const key = (k: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k }));
const move = (x: number, y: number) => dom.window.dispatchEvent(Object.assign(new dom.window.Event("pointermove"), { screenX: x, screenY: y }));

test("rows sliding under a still pointer after a key press do not take the cursor; a real move does", () => {
  const hits: number[] = [];
  const row = (i: number) => hoverFocus(() => hits.push(i));
  move(10, 10);
  row(1).onMouseEnter();
  expect(hits).toEqual([1]);

  key("j");
  expect(keyboardOwnsFocus()).toBe(true);
  row(2).onMouseEnter();
  move(10, 10); // same spot: the list scrolled, the pointer did not move
  row(3).onMouseMove();
  expect(hits).toEqual([1]);

  key("Shift"); // a modifier alone leaves ownership where it was
  move(12, 10);
  expect(keyboardOwnsFocus()).toBe(false);
  row(4).onMouseMove();
  expect(hits).toEqual([1, 4]);
});
