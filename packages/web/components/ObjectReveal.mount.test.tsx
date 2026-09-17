// Mounts RevealHost + RevealButton in jsdom with the page renderers stubbed
// and checks the wiring the browser shows: the band portals into the slot
// under the reference's block, the foot closes it, opening a reference in
// another host closes the first, and a host inside a band is inert.
// Run: bun test --timeout 120000 components/ObjectReveal.mount.test.tsx
import { test, expect, beforeAll, beforeEach, mock } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let mod: typeof import("./ObjectReveal");
let store: typeof import("../lib/revealHost");

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "Element", "Node", "Event", "PointerEvent", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"]) {
    const v = (dom.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true });
  }
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  if (!(globalThis as any).PointerEvent) (globalThis as any).PointerEvent = (globalThis as any).MouseEvent;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  const h = React.createElement;
  mock.module("./RoutePane", () => ({ RoutePane: ({ path }: { path: string }) => h("div", { "data-path": path }, "page") }));
  mock.module("./stage/SessionPane", () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => h("div", { "data-session": sessionId }, "session") }));
  mock.module("./RecentVisitRow", () => ({ PageIcon: () => h("i"), pageAccent: () => "var(--sol-cyan)" }));
  mock.module("./KeyboardShortcutsHelp", () => ({ KeyCap: ({ children }: any) => h("kbd", null, children) }));
  mock.module("./ErrorBoundary", () => ({ ErrorBoundary: ({ children }: any) => h(React.Fragment, null, children) }));
  mock.module("../shortcuts", () => ({ hasOpenModal: () => false, isEditableTarget: () => false }));
  mock.module("../store/inboxStore", () => ({ useInboxStore: { getState: () => ({ sessions: {} }) } }));
  mock.module("../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
  mock.module("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {} }) }));
  ({ createRoot } = await import("react-dom/client"));
  mod = await import("./ObjectReveal");
  store = await import("../lib/revealHost");
}, 120_000);

// The open reveal is page state: every test starts with none.
beforeEach(() => store.closeReveal());

let root: ReturnType<typeof createRoot> | null = null;
function mount(ui: React.ReactNode) {
  root ??= createRoot(document.getElementById("root")!);
  React.act(() => root.render(ui));
  return root;
}
const click = (el: Element) => React.act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })); });

test("the band portals into a slot right under the reference's paragraph and the foot closes it", () => {
  const { RevealHost, RevealButton } = mod;
  const h = React.createElement;
  mount(
    h("div", { className: "cc-content" },
      h(RevealHost, { persistKey: "m1" },
        h("p", null, "before"),
        h("p", null, "see ", h(RevealButton, { target: { href: "/tasks/a", title: "Task: a" } })),
        h("p", null, "after"),
      ),
    ),
  );
  const content = document.querySelector(".cc-content")!;
  click(content.querySelector("button")!);
  const kids = Array.from(content.children).map((c) => c.tagName + (c.hasAttribute("data-reveal-slot") ? "[slot]" : ""));
  expect(kids).toEqual(["P", "P", "DIV[slot]", "P"]);
  const band = content.querySelector(".object-reveal")!;
  expect(band.querySelector("[data-path]")?.getAttribute("data-path")).toBe("/tasks/a");
  expect(content.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
  // The grip is there for the resize; the foot is a plain click to close.
  expect(band.querySelector(".object-reveal__grip-bar")).not.toBeNull();
  click(band.querySelector(".object-reveal__foot")!);
  expect(content.querySelector("[data-reveal-slot]")).toBeNull();
  expect(content.querySelector("button")?.getAttribute("aria-pressed")).toBe("false");
  // The header strip closes as well; the open-the-page bars do not.
  click(content.querySelector("button")!);
  const opens = content.querySelectorAll(".object-reveal__open");
  expect(opens.length).toBe(2);
  click(opens[0]!);
  expect(content.querySelector(".object-reveal")).not.toBeNull();
  click(content.querySelector(".object-reveal__strip")!);
  expect(content.querySelector(".object-reveal")).toBeNull();
  React.act(() => root!.render(null));
});

test("opening a reference in another host closes the first; a host inside the band is inert", () => {
  const { RevealHost, RevealButton } = mod;
  const h = React.createElement;
  const Page = () => h(RevealHost, null, h("p", null, "inner ", h(RevealButton, { target: { href: "/tasks/x", title: "Task: x" } })));
  mock.module("./RoutePane", () => ({ RoutePane: ({ path }: { path: string }) => h("div", { "data-path": path }, h(Page)) }));
  mount(
    h("div", { className: "cc-content" },
      h(RevealHost, { persistKey: "m1" }, h("p", null, h(RevealButton, { target: { href: "/tasks/a", title: "Task: a" }, className: "a" }))),
      h(RevealHost, { persistKey: "m2" }, h("p", null, h(RevealButton, { target: { href: "/tasks/b", title: "Task: b" }, className: "b" }))),
    ),
  );
  const content = document.querySelector(".cc-content")!;
  click(content.querySelector("button.a")!);
  expect(content.querySelectorAll(".object-reveal").length).toBe(1);
  // The revealed page's own host renders no reveal control.
  expect(content.querySelector(".object-reveal button[aria-pressed]")).toBeNull();
  click(content.querySelector("button.b")!);
  const bands = content.querySelectorAll(".object-reveal");
  expect(bands.length).toBe(1);
  expect(bands[0].querySelector("[data-path]")?.getAttribute("data-path")).toBe("/tasks/b");
  expect(content.querySelector("button.a")?.getAttribute("aria-pressed")).toBe("false");
  expect(content.querySelector("button.b")?.getAttribute("aria-pressed")).toBe("true");
  React.act(() => root!.render(null));
});

test("wheel on the hatch lane scrolls the conversation; wheel in the frame scrolls the object", () => {
  const { revealWheelGoesToParent } = mod;
  const band = document.createElement("div");
  band.className = "object-reveal";
  const lane = document.createElement("div");
  lane.className = "object-reveal__lane";
  const frame = document.createElement("div");
  frame.className = "object-reveal__frame";
  const body = document.createElement("div");
  body.className = "object-reveal__body";
  frame.appendChild(body);
  band.append(lane, frame);
  expect(revealWheelGoesToParent(lane, band)).toBe(true);
  expect(revealWheelGoesToParent(body, band)).toBe(false);
  expect(revealWheelGoesToParent(band, band)).toBe(true);
  const open = document.createElement("a");
  open.className = "object-reveal__open";
  band.appendChild(open);
  expect(revealWheelGoesToParent(open, band)).toBe(true);
});
