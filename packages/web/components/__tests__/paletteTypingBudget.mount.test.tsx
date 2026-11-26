// The command palette's typing budget, held with a realistic cache (7,000
// sessions). Typing into Cmd+K lagged on every key (280-445 ms frames, mostly
// script in React's root input listener, with forced layout; ct-101635): each
// keystroke paid for the whole palette, not the box. This test pins what the
// keystroke itself (the urgent work React does inside the input event, before
// the deferred ranking render) may cost once the box holds text: no read of
// layout (each forces the browser to lay out the page) and no reshuffle of
// the result rows' DOM. The ranked results follow in the background render
// the next key can interrupt; they are not the keystroke's cost.
// A failure names the budget that broke; look at what the keystroke reaches.
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
}));
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const USER = "user_palette_budget";
const SESSIONS = 7000;

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

function syntheticSessions(n: number): Record<string, any> {
  const out: Record<string, any> = {};
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const id = `jx7${String(i).padStart(29, "0")}`;
    out[id] = { _id: id, session_id: `s-${i}`, title: `Session ${i} fixing the deploy pipeline`, user_id: USER, agent_type: "claude_code", status: i % 9 ? "completed" : "active", is_idle: i % 9 !== 0, message_count: 20 + (i % 50), updated_at: now - i * 60_000, started_at: now - i * 120_000, project_path: `/src/p${i % 40}` };
  }
  return out;
}

w.HTMLElement.prototype.scrollIntoView = function () {};

// Every read that makes the browser lay out the page when it is dirty, named
// with the line that made it. scrollIntoView lays out the page to know where
// the row is, so it counts as one.
const readSite = (name: string) => `${name} ${new Error().stack!.split("\n").find((l) => (l.includes("/packages/web/") || l.includes("/cmdk/")) && !l.includes("__tests__"))?.trim() ?? "?"}`;
const LAYOUT_GETTERS: Array<[any, string]> = [
  [w.HTMLElement.prototype, "offsetWidth"], [w.HTMLElement.prototype, "offsetHeight"], [w.HTMLElement.prototype, "offsetParent"],
  [w.Element.prototype, "clientWidth"], [w.Element.prototype, "clientHeight"],
  [w.Element.prototype, "scrollWidth"], [w.Element.prototype, "scrollHeight"],
];
let layoutReads: string[] = [];
for (const [proto, name] of LAYOUT_GETTERS) {
  const desc = Object.getOwnPropertyDescriptor(proto, name)!;
  Object.defineProperty(proto, name, { ...desc, get() { layoutReads.push(readSite(name)); return desc.get!.call(this); } });
}
for (const [owner, name] of [[w.Element.prototype, "getBoundingClientRect"], [w.HTMLElement.prototype, "scrollIntoView"], [w, "getComputedStyle"], [globalThis, "getComputedStyle"]] as Array<[any, string]>) {
  const real = owner[name];
  owner[name] = function (this: unknown, ...args: unknown[]) { layoutReads.push(readSite(name)); return real.apply(this, args); };
}

let container: HTMLElement;
let input: HTMLInputElement;

beforeAll(async () => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ sessions: syntheticSessions(SESSIONS), conversations: {}, currentUser: { _id: USER, name: "Typist" } } as any);
  for (let i = 0; i < 400 && !useInboxStore.getState().clientStateInitialized; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  useInboxStore.getState().openPalette();
  const { CommandPalette } = await import("../CommandPalette");
  container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ConvexProvider client={fakeConvex()}><CommandPalette /></ConvexProvider>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  input = container.querySelector("input[cmdk-input]") as HTMLInputElement;
});

// A typed key as React delivers it: the input event's handler runs and its
// update renders synchronously (discrete input), which is the frame the
// person waits on. The deferred ranking render runs after, outside the tally.
type Tally = { ms: number; layoutReads: string[]; rowMoves: number };
async function typeChar(ch: string): Promise<Tally> {
  const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps"))!;
  const props = (input as any)[propsKey];
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(input, input.value + ch);
  let rowMoves = 0;
  const mo = new w.MutationObserver((rs: MutationRecord[]) => { for (const r of rs) if (r.type === "childList") rowMoves += r.addedNodes.length; });
  const list = container.querySelector("[cmdk-list]")!;
  mo.observe(list, { subtree: true, childList: true });
  layoutReads = [];
  const t0 = performance.now();
  // Discrete event: React renders and commits it before the event returns,
  // with its layout effects (cmdk filters and sorts its items there).
  flushSync(() => { props.onChange({ target: input, currentTarget: input, nativeEvent: new w.Event("input") }); });
  const ms = performance.now() - t0;
  const reads = layoutReads;
  rowMoves += mo.takeRecords().filter((r: MutationRecord) => r.type === "childList").reduce((n: number, r: MutationRecord) => n + r.addedNodes.length, 0);
  mo.disconnect();
  // Let the deferred ranking render finish before the next key.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { ms, layoutReads: reads, rowMoves };
}

test("a keystroke into the palette with text reads no layout and moves no result rows", async () => {
  expect(input).toBeTruthy();
  await typeChar("d");
  await typeChar("e");
  const mounted = container.querySelectorAll("[cmdk-item]").length;
  const reads = new Set<string>();
  let rowMoves = 0;
  let worstMs = 0;
  for (const ch of "ploy pipe") {
    const t = await typeChar(ch);
    for (const r of t.layoutReads) reads.add(r);
    rowMoves += t.rowMoves;
    worstMs = Math.max(worstMs, t.ms);
  }
  expect(input.value).toBe("deploy pipe");
  console.log(`palette keystroke: ${mounted} rows mounted, worst ${worstMs.toFixed(0)} ms, ${rowMoves} row moves, ${reads.size} layout read sites`);
  expect({ layoutReadsWhileTyping: [...reads] }).toEqual({ layoutReadsWhileTyping: [] });
  expect({ rowMovesWhileTyping: rowMoves }).toEqual({ rowMovesWhileTyping: 0 });
});
