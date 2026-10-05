// usePressOutside closes a popover on a press outside it and, when asked, on
// Escape, and that Escape never reaches a handler behind it (a stage that
// collapses on Escape). Mounted in jsdom.
// Run: bun test --timeout 120000 hooks/usePressOutside.mount.test.tsx
import { beforeAll, beforeEach, expect, test } from "bun:test";

let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let usePressOutside: typeof import("./usePressOutside").usePressOutside;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ usePressOutside } = await import("./usePressOutside"));
});

let closes = 0;
let behind = 0;

function Popover({ active, escape }: { active: boolean; escape?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  usePressOutside(ref, active, () => closes++, { escape });
  return React.createElement("div", { id: "inside", ref }, React.createElement("button", { id: "child" }, "Keep"));
}

function mount(active: boolean, escape?: boolean) {
  document.body.innerHTML = "<div id='root'></div><button id='outside'>elsewhere</button>";
  const root = createRoot(document.getElementById("root")!);
  act(() => root.render(React.createElement(Popover, { active, escape })));
  return root;
}

// A real pointerdown, which jsdom lacks as a constructor: a plain Event of
// that type is what the listener hears.
const press = (id: string) =>
  document.getElementById(id)!.dispatchEvent(new (window as any).Event("pointerdown", { bubbles: true }));
const esc = () => document.body.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

beforeEach(() => {
  closes = 0;
  behind = 0;
});

test("a press inside keeps it open, a press outside closes it", () => {
  const root = mount(true);
  press("child");
  expect(closes).toBe(0);
  press("outside");
  expect(closes).toBe(1);
  act(() => root.unmount());
});

test("nothing listens while it is not active", () => {
  const root = mount(false, true);
  press("outside");
  esc();
  expect(closes).toBe(0);
  act(() => root.unmount());
});

test("Escape closes it and never reaches a handler behind it", () => {
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && behind++;
  window.addEventListener("keydown", onKey);
  const root = mount(true, true);
  esc();
  expect(closes).toBe(1);
  expect(behind).toBe(0);
  act(() => root.unmount());
  // Closed and gone, the key belongs to the stage again.
  esc();
  expect(behind).toBe(1);
  window.removeEventListener("keydown", onKey);
});

test("without escape the key is left alone", () => {
  const root = mount(true);
  esc();
  expect(closes).toBe(0);
  act(() => root.unmount());
});
