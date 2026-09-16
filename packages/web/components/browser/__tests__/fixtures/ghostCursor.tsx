// A real BrowserStream against a fake daemon socket: ready, one frame, then
// action frames. Proves the whole path, socket message to cursor element:
// the arrow appears where the action points, glides on the next one, rings
// on a press, captions typing, hides while the human has the wheel, and the
// nav frame reaches the host's report. Spawned by ghostCursor.mount.test.ts
// so the module mocks stay in this process.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLImageElement", "Element", "Node", "MutationObserver", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The stream box is 400x300 and the frame is 800x600: the content fills the
// box exactly, so a normalized point maps to (nx*400, ny*300).
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} } as DOMRect;
};
(globalThis as any).ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

// The socket. One instance per dial; the test speaks the daemon's side.
const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  // Daemon side.
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
(globalThis as any).WebSocket = FakeSocket;

const convexReact = await import("convex/react");
// One client object for the whole run: the stream's connect effect keys on
// it, and a fresh object per render would dial again on every render.
const fakeConvex = {};
mock.module("convex/react", () => ({ ...convexReact, useConvex: () => fakeConvex }));
mock.module("../../../../lib/terminal/endpoint", () => ({
  getTerminalEndpoint: async () => ({ port: 4321, token: "t".repeat(32) }),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BrowserStream } = await import("../../BrowserStream");
const { GHOST_SECRET_CAPTION } = await import("../../../../lib/browserGhost");
type Report = import("../../../../lib/browserWatch").BrowserStreamReport;

const container = document.getElementById("root")!;
const root = createRoot(container);
const reports: Report[] = [];
let control = false;
let reload = 0;
const render = () =>
  root.render(
    <BrowserStream
      sessionUuid="sess-1"
      paneActive
      control={control}
      reloadToken={reload}
      onState={(r) => reports.push(r)}
      onReleaseControl={() => {
        control = false;
      }}
    />,
  );
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));
const cursor = () => container.querySelector<HTMLElement>("[data-sv-ghost-cursor]");
const translate = () => cursor()?.style.transform ?? null;
// A 1x1 white JPEG is plenty: the img never decodes under jsdom, the size
// comes from the frame message.
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

try {
  await act(() => render());
  await settle();
  assert.equal(sockets.length, 1, "one dial");
  const ws = sockets[0];
  await act(() => ws.open());
  const hello = JSON.parse(ws.sent[0]);
  assert.equal(hello.type, "hello");
  assert.equal(hello.protocol, 2, "the viewer names the protocol it speaks");
  await act(() => ws.deliver({ type: "ready", protocol: 2, targetId: "tab-1", title: "Stripe", url: "https://stripe.com/", control: true }));
  await act(() => ws.deliver({ type: "frame", data: JPEG, w: 800, h: 600 }));
  assert.ok(container.querySelector("img"), "the frame painted");
  assert.equal(cursor(), null, "no actions yet: no cursor");

  // A move puts the arrow at the point.
  const at = Date.now();
  await act(() => ws.deliver({ type: "action", kind: "move", x: 0.25, y: 0.5, at }));
  assert.ok(cursor(), "an action frame draws the cursor");
  assert.equal(translate(), "translate(100px, 150px)");
  assert.equal(cursor()!.dataset.visible, "true");
  assert.equal(container.querySelector("[data-sv-ghost-ripple]"), null);

  // The next one moves it (the glide is CSS; the target is what we can see).
  await act(() => ws.deliver({ type: "action", kind: "down", x: 0.75, y: 0.25, at: at + 100 }));
  assert.equal(translate(), "translate(300px, 75px)");
  assert.ok(container.querySelector("[data-sv-ghost-ripple]"), "a press rings");

  // Typing captions the field; a secret field says only that something is typed.
  await act(() => ws.deliver({ type: "action", kind: "type", x: 0.5, y: 0.5, text: "ada@x.org", at: at + 200 }));
  assert.equal(container.querySelector("[data-sv-ghost-caption]")?.textContent, "ada@x.org");
  await act(() => ws.deliver({ type: "action", kind: "type", x: 0.5, y: 0.6, secret: true, at: at + 300 }));
  assert.equal(container.querySelector("[data-sv-ghost-caption]")?.textContent, GHOST_SECRET_CAPTION);

  // A navigation changes the address at once and the host hears when.
  await act(() => ws.deliver({ type: "action", kind: "nav", x: 0.5, y: 0.6, url: "https://stripe.com/checkout", at: at + 400 }));
  const last = reports[reports.length - 1];
  assert.equal(last.tab?.url, "https://stripe.com/checkout");
  assert.deepEqual(last.nav, { url: "https://stripe.com/checkout", at: at + 400 });
  assert.equal(last.controlAvailable, true);

  // The human takes the wheel: the arrow hides, the hint shows, Esc hands back.
  control = true;
  await act(() => render());
  assert.equal(cursor()!.dataset.visible, "false", "the ghost hides while the human drives");
  const hint = container.querySelector("[data-sv-driving-hint]");
  assert.ok(hint, "the driving hint is shown");
  assert.ok(hint!.querySelector("kbd"), "Esc renders as a keycap");
  const surface = container.querySelector<HTMLElement>("[role=application]")!;
  assert.equal(document.activeElement, surface, "the control surface takes focus at once");
  await act(() => {
    surface.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(control, false, "Esc asked the host to hand back");
  await act(() => render());
  assert.equal(cursor()!.dataset.visible, "true", "the agent's cursor returns after hand back");
  assert.equal(container.querySelector("[data-sv-driving-hint]"), null);

  // Unknown message types are ignored, as the protocol promises.
  await act(() => ws.deliver({ type: "someday", x: 1 }));
  assert.equal(translate(), "translate(200px, 180px)");

  // A scroll is activity where the arrow already is, not a jump to the
  // point the page guessed (the viewport center on a fresh document).
  await act(() => ws.deliver({ type: "action", kind: "scroll", x: 0.5, y: 0.5, at: at + 500 }));
  assert.equal(translate(), "translate(200px, 180px)");

  // The stream stops being live: the arrow freezes where it was and is left
  // to the idle fade, not hidden at once.
  await act(() => ws.deliver({ type: "error", code: "no-tab", message: "gone" }));
  assert.equal(cursor()!.dataset.visible, "true", "a stalled stream freezes the arrow");
  assert.equal(translate(), "translate(200px, 180px)");

  // A new stream (a redial) starts with no memory; the replay after ready
  // puts the cursor back when it is still current.
  reload++;
  await act(() => render());
  await settle();
  assert.equal(sockets.length, 2, "the host's retry dials again");
  const ws2 = sockets[1];
  await act(() => ws2.open());
  await act(() => ws2.deliver({ type: "ready", protocol: 2, targetId: "tab-1", title: "Stripe", url: "https://stripe.com/", control: true }));
  assert.equal(cursor(), null, "ready clears the previous stream's cursor");
  await act(() => ws2.deliver({ type: "action", kind: "move", x: 0.5, y: 0.5, at: at + 600 }));
  assert.equal(translate(), "translate(200px, 150px)", "the replayed action draws it again");

  console.log("PASS: action frames move the ghost cursor, ring on press, caption typing, hide while driving");
} finally {
  await act(() => root.unmount());
  dom.window.close();
}
