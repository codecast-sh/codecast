import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><body></body>");
(globalThis as any).window = dom.window;
const added: string[] = [];
const realAdd = dom.window.addEventListener.bind(dom.window);
dom.window.addEventListener = ((type: string, ...rest: any[]) => { added.push(type); return (realAdd as any)(type, ...rest); }) as any;
const { hoverFocus, keyboardOwnsFocus } = await import("./focusSource");
afterAll(() => { delete (globalThis as any).window; closeDomWindow(dom); });

const key = (k: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k }));
const move = (x: number, y: number) => dom.window.dispatchEvent(Object.assign(new dom.window.Event("pointermove"), { screenX: x, screenY: y }));

// A page that only loads a module with a keyboard list (the homepage hero)
// takes no page keys: the watch starts with the first row a list renders.
test("importing it listens to nothing; the first row starts the watch, once", () => {
  expect(added).toEqual([]);
  hoverFocus(() => {});
  hoverFocus(() => {});
  expect(added).toEqual(["keydown", "pointermove", "pointerdown"]);
});

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
