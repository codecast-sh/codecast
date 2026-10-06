import { test, expect } from "bun:test";

// The first window listener runs claims ahead of the shortcut handler and of
// every other listener. A plain EventTarget stands in for window.
const win = new EventTarget();
(globalThis as any).window = win;
const { claimKeys, setShortcutHandler } = await import("./listener");

const key = (k: string) => Object.assign(new Event("keydown", { cancelable: true }), { key: k }) as unknown as KeyboardEvent;

test("a claimed key reaches neither the shortcut handler nor a later listener; an unclaimed one reaches both", () => {
  const seen: string[] = [];
  setShortcutHandler((e) => seen.push(`shortcut:${e.key}`));
  const later = (e: Event) => seen.push(`page:${(e as KeyboardEvent).key}`);
  win.addEventListener("keydown", later, true);
  const release = claimKeys((e) => e.key === "Escape");
  try {
    win.dispatchEvent(key("Escape"));
    win.dispatchEvent(key("j"));
    expect(seen).toEqual(["shortcut:j", "page:j"]);
    release();
    seen.length = 0;
    win.dispatchEvent(key("Escape"));
    expect(seen).toEqual(["shortcut:Escape", "page:Escape"]);
  } finally {
    release();
    win.removeEventListener("keydown", later, true);
    setShortcutHandler(null);
  }
});

test("the newest claim answers first", () => {
  const order: string[] = [];
  const a = claimKeys(() => { order.push("a"); return true; });
  const b = claimKeys(() => { order.push("b"); return true; });
  win.dispatchEvent(key("Enter"));
  b();
  win.dispatchEvent(key("Enter"));
  a();
  expect(order).toEqual(["b", "a"]);
});

test("a window swapped in after load gets the handler: a test file's jsdom is not the one the module loaded under", () => {
  const next = new EventTarget();
  (globalThis as any).window = next;
  const seen: string[] = [];
  try {
    setShortcutHandler((e) => seen.push(e.key));
    next.dispatchEvent(key("ArrowLeft"));
    win.dispatchEvent(key("j"));
    expect(seen).toEqual(["ArrowLeft"]);
  } finally {
    setShortcutHandler(null);
    (globalThis as any).window = win;
  }
});
