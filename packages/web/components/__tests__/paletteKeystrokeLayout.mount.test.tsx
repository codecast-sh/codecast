// A keystroke in the command palette reads no layout (ct-101383).
// In Chrome each palette keystroke froze the page for ~100-300 ms, most of it
// forced layout inside React's root input listener (replay rp-25184:
// "DIV#root.oninput", forced 65 ms of 111). Every read below makes the browser
// lay out the whole page when the DOM is dirty, which it always is right
// after a keystroke re-rendered the result list: geometry getters,
// getBoundingClientRect, getComputedStyle, scrollIntoView, and a write of
// scrollTop (the browser lays out to clamp it). This mounts the real palette
// over a cache of 5,000 sessions, types into its box, and counts them. A
// failure names each read with the app line that made it.
import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...realNav,
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(),
}));

import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

afterAll(() => {
  mock.module("next/navigation", () => realNav);
  closeDomWindow(dom);
  restoreGlobals();
});

const SESSIONS = 5000;
const USER = "user_palette_budget";

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).action = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

function syntheticSessions(n: number): Record<string, any> {
  const out: Record<string, any> = {};
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const id = `jx7${String(i).padStart(29, "0")}`;
    out[id] = { _id: id, session_id: `s-${i}`, title: `Session ${i} fix the auth race`, user_id: USER, agent_type: "claude_code", status: i % 9 ? "completed" : "active", is_idle: i % 9 !== 0, message_count: 20 + (i % 50), updated_at: now - i * 60_000, started_at: now - i * 120_000, project_path: `/src/p${i % 40}` };
  }
  return out;
}

// jsdom has none of these; the app's paths that call them must still run.
// react-dom is first loaded by the test preload, before this file's window
// exists, so it takes its old-browser path for text inputs: it listens for
// "propertychange" through attachEvent and reads a changed value on keyup.
(w.HTMLElement.prototype as any).attachEvent = function () {};
(w.HTMLElement.prototype as any).detachEvent = function () {};
w.HTMLElement.prototype.scrollIntoView = function () {};
(w.HTMLCanvasElement.prototype as any).getContext = () => ({ font: "", measureText: (t: string) => ({ width: t.length * 7 }) });

const readSite = (name: string) => {
  const lines = new Error().stack!.split("\n").map((l) => l.trim());
  const app = lines.find((l) => l.includes("/packages/web/") && !l.includes("__tests__") && !l.includes("node_modules"));
  const lib = lines.find((l) => l.includes("node_modules") && !l.includes("react-dom") && !l.includes("jsdom"));
  return `${name} ${app ?? lib ?? "?"}`;
};
let layoutReads: string[] = [];
for (const [proto, name] of [
  [w.HTMLElement.prototype, "offsetWidth"], [w.HTMLElement.prototype, "offsetHeight"], [w.HTMLElement.prototype, "offsetTop"], [w.HTMLElement.prototype, "offsetLeft"], [w.HTMLElement.prototype, "offsetParent"],
  [w.Element.prototype, "clientWidth"], [w.Element.prototype, "clientHeight"],
  [w.Element.prototype, "scrollWidth"], [w.Element.prototype, "scrollHeight"],
] as Array<[any, string]>) {
  const desc = Object.getOwnPropertyDescriptor(proto, name)!;
  Object.defineProperty(proto, name, { ...desc, get() { layoutReads.push(readSite(name)); return desc.get!.call(this); } });
}
for (const name of ["scrollTop", "scrollLeft"]) {
  const desc = Object.getOwnPropertyDescriptor(w.Element.prototype, name)!;
  Object.defineProperty(w.Element.prototype, name, {
    ...desc,
    get() { layoutReads.push(readSite(name)); return desc.get!.call(this); },
    set(v) { layoutReads.push(readSite(`${name}=`)); desc.set!.call(this, v); },
  });
}
for (const [owner, name] of [[w.Element.prototype, "getBoundingClientRect"], [w.HTMLElement.prototype, "scrollIntoView"], [w, "getComputedStyle"], [globalThis, "getComputedStyle"]] as Array<[any, string]>) {
  const real = owner[name];
  owner[name] = function (this: unknown, ...args: unknown[]) { layoutReads.push(readSite(name)); return real.apply(this, args); };
}

let input: HTMLInputElement;
const setValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!;

async function settle(ms = 30) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

beforeAll(async () => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ sessions: syntheticSessions(SESSIONS), conversations: {}, pendingMessages: {}, drafts: {}, currentUser: { _id: USER, name: "Typist" } } as any);
  for (let i = 0; i < 400 && !useInboxStore.getState().clientStateInitialized; i++) await settle(50);
  const { CommandPalette } = await import("../CommandPalette");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <CommandPalette standalone />
      </ConvexProvider>,
    );
  });
  await settle(100);
  input = container.querySelector("input[cmdk-input]") as HTMLInputElement;
});

// One typed character: the value changes and React's root input listener runs,
// then everything the render it schedules does (effects, cmdk's scheduled
// selection) before the browser would next paint.
async function typeKey(ch: string): Promise<string[]> {
  layoutReads = [];
  await act(async () => {
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: ch, bubbles: true }));
    setValue.call(input, input.value + ch);
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    input.dispatchEvent(new w.KeyboardEvent("keyup", { key: ch, bubbles: true }));
  });
  await settle(20);
  return layoutReads;
}

test("the palette mounted over the cache, with its search box", () => {
  expect(input).toBeTruthy();
  expect(Object.keys(useInboxStore.getState().sessions).length).toBeGreaterThanOrEqual(SESSIONS);
});

test("a keystroke in the palette reads no layout", async () => {
  const reads: string[] = [];
  for (const ch of "session 4") reads.push(...(await typeKey(ch)));
  expect(input.value).toBe("session 4");
  expect(reads).toEqual([]);
});
