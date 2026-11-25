import { afterAll, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// The reply being written, in the real conversation view (InboxConversation →
// ConversationDiffLayout → ConversationView, as the inbox mounts it): its own
// feed row where its message will sort, with the box of an assistant text row;
// pushes re-render the block and not the view; the message that lands takes
// the same row; it holds still for a reader scrolled up and keeps the bottom
// pinned; it leaves nothing when stale; nothing in a deep-linked window; no
// subscription with the flag off.
//
// Geometry as perf/harness.tsx fakes it (jsdom lays nothing out): every
// element 50px, the feed 800px, except a feed row, which is as tall as its
// text (one px per character, at least 50) so a growing reply grows its row.
// Observed sizes are reported on observe and again on resizeObserved().

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/inbox", pretendToBeVisual: true });
const w = dom.window as any;
const VIEWPORT = 800;
const offsets = new WeakMap<Element, number>();
const isFeed = (el: Element) => el.hasAttribute("data-sv-feed");
const heightOf = (el: Element): number => {
  if ((el as HTMLElement).style?.height === "0px") return 0;
  if (isFeed(el)) return VIEWPORT;
  if (el.hasAttribute("data-vkey")) return Math.max(50, (el.textContent ?? "").length);
  return 50;
};
const scrollHeightOf = (el: Element) => (isFeed(el) ? Math.max(VIEWPORT, Number.parseFloat(el.querySelector<HTMLElement>('div[style*="position: relative"][style*="height"]')?.style.height || "0")) : heightOf(el));
const geometry = (value: (el: HTMLElement) => number) => ({ get(this: HTMLElement) { return value(this); }, configurable: true });
Object.defineProperties(w.HTMLElement.prototype, {
  offsetHeight: geometry(heightOf),
  offsetWidth: geometry(() => 700),
  clientHeight: geometry(heightOf),
  clientWidth: geometry(() => 700),
  scrollHeight: geometry(scrollHeightOf),
  scrollWidth: geometry(() => 700),
  offsetTop: geometry(() => 0),
  offsetParent: { get: () => w.document.body, configurable: true },
  scrollTop: {
    get(this: Element) { return offsets.get(this) ?? 0; },
    set(this: HTMLElement, v: number) {
      const next = Math.max(0, Math.min(v, Math.max(0, scrollHeightOf(this) - heightOf(this))));
      if (next === (offsets.get(this) ?? 0)) return;
      offsets.set(this, next);
      queueMicrotask(() => { if (this.isConnected) this.dispatchEvent(new w.Event("scroll")); });
    },
    configurable: true,
  },
});
w.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const h = heightOf(this);
  return { x: 0, y: 0, top: 0, left: 0, right: 700, bottom: h, width: 700, height: h, toJSON() {} };
};
w.HTMLElement.prototype.scrollTo = function (this: HTMLElement, x: any, y?: number) { this.scrollTop = typeof x === "object" ? x.top ?? this.scrollTop : y ?? 0; };
w.HTMLElement.prototype.scrollIntoView = () => {};
w.HTMLCanvasElement.prototype.getContext = () => ({ font: "", measureText: (t: string) => ({ width: t.length * 7 }) });
class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
const sizeObservers = new Set<SizeObserver>();
class SizeObserver {
  targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) { sizeObservers.add(this); }
  report(el: Element) {
    const h = heightOf(el);
    this.callback([{ target: el, contentRect: { height: h, width: 700 }, contentBoxSize: [{ blockSize: h, inlineSize: 700 }], borderBoxSize: [{ blockSize: h, inlineSize: 700 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  observe(el: Element) { this.targets.add(el); queueMicrotask(() => { if (this.targets.has(el) && el.isConnected) this.report(el); }); }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); sizeObservers.delete(this); }
}
const restoreGlobals = replaceGlobals({
  window: w, document: w.document, navigator: w.navigator, localStorage: w.localStorage, sessionStorage: w.sessionStorage,
  location: w.location, history: w.history, indexedDB, IDBKeyRange,
  HTMLElement: w.HTMLElement, HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLInputElement: w.HTMLInputElement, HTMLAnchorElement: w.HTMLAnchorElement,
  Element: w.Element, Node: w.Node, Text: w.Text, Document: w.Document, DocumentFragment: w.DocumentFragment, ShadowRoot: w.ShadowRoot, SVGElement: w.SVGElement,
  Event: w.Event, CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, WheelEvent: w.WheelEvent, FocusEvent: w.FocusEvent,
  MutationObserver: w.MutationObserver, DOMRect: w.DOMRect, DOMParser: w.DOMParser, customElements: w.customElements, getComputedStyle: w.getComputedStyle.bind(w),
  ResizeObserver: SizeObserver, IntersectionObserver: NoopObserver, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0),
  cancelAnimationFrame: (id: any) => clearTimeout(id),
  requestIdleCallback: (cb: any) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0),
  cancelIdleCallback: (id: any) => clearTimeout(id),
  CSS: { escape: (s: string) => s.replace(/["\\]/g, "\\$&") },
  IS_REACT_ACT_ENVIRONMENT: true,
});
w.ResizeObserver = SizeObserver;
w.IntersectionObserver = NoopObserver;
const realError = console.error;
console.error = (...args: unknown[]) => { if (String(args[0]).includes("not wrapped in act")) return; realError(...args); };

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProviderWithAuth } = await import("convex/react");
const { getFunctionName } = await import("convex/server");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../store/inboxStore");
const { flushSyncPublishes } = await import("../../store/syncTransaction");
const { tickCoarseClocks } = await import("../../hooks/useCoarseNow");
const { InboxConversation } = await import("../../app/inbox/QueuePageClient");

// A Convex client that confirms the caller, answers nothing and records each
// subscription opened.
let subscribed: string[] = [];
let mutated: string[] = [];
const convex = {
  clearAuth() {},
  setAuth(_fetch: unknown, onChange?: (authenticated: boolean) => void) { queueMicrotask(() => onChange?.(true)); },
  watchQuery(q: any) {
    const name = getFunctionName(q);
    return { onUpdate: () => { subscribed.push(name); return () => {}; }, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined };
  },
  query: () => new Promise(() => {}),
  mutation: (m: any) => { mutated.push(typeof m === "string" ? m : getFunctionName(m)); return Promise.resolve(null); },
  action: () => Promise.resolve(null),
  connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false, hasEverConnected: true, connectionCount: 1 }),
  subscribeToConnectionState: () => () => {},
  prewarmQuery() {},
} as any;
const useAuth = () => ({ isLoading: false, isAuthenticated: true, fetchAccessToken: async () => "t" });

const ME = "user_reply_stream";
const CONV = "jx7" + "r".repeat(29);
const T = Date.now() - 60_000;
const id = (n: number) => `${CONV.slice(0, 20)}m${String(n).padStart(11, "0")}`;

afterAll(() => {
  console.error = realError;
  closeDomWindow(dom);
  restoreGlobals();
});

// `full`: the full-density feed (simple view off); else condensed, the
// default when the preference is unset.
function seed(flagOn: boolean, { full = false }: { full?: boolean } = {}) {
  (useInboxStore.getState() as any)._setDispatch?.(async () => undefined);
  useInboxStore.setState((s: any) => ({
    sessions: {}, conversations: {}, messages: {}, pendingMessages: {}, drafts: {}, replyStreams: {},
    teams: flagOn ? [{ _id: "team_rs", name: "T", features: { reply_streaming: true } }] : [],
    currentUser: { _id: ME, name: "Tester" }, clientStateInitialized: true,
    clientState: { ...s.clientState, ui: { ...(s.clientState?.ui ?? {}), simple_view: !full } },
  }) as any);
  useInboxStore.getState().syncTable("sessions", [{
    _id: CONV, session_id: "s-rs", title: "Streaming", user_id: ME, agent_type: "claude_code", status: "active", is_idle: false,
    agent_status: "working", message_count: 5, updated_at: T, started_at: T - 100_000, last_heartbeat: Date.now(), project_path: "/src/p", git_branch: "main",
  }] as any);
  // Text, then a tool call and its result: the tool-result row draws nothing.
  useInboxStore.getState().setMessages(CONV, [
    { _id: id(0), conversation_id: CONV, role: "user", content: "Why does the inbox jump?", timestamp: T },
    { _id: id(1), conversation_id: CONV, role: "assistant", content: "Let me read the sync layer.", timestamp: T + 1_000, model: "claude-opus-4" },
    { _id: id(2), conversation_id: CONV, role: "assistant", content: "", tool_calls: [{ id: "tu1", name: "Read", input: JSON.stringify({ file_path: "/src/sync.ts" }) }], timestamp: T + 2_000, model: "claude-opus-4" },
    { _id: id(3), conversation_id: CONV, role: "user", content: "", tool_results: [{ tool_use_id: "tu1", content: "export const x = 1;" }], timestamp: T + 3_000 },
  ] as any, { initialized: true } as any);
}

const STARTED = T + 10_000;
const push = (seq: number, text: string, receivedAt = Date.now()) => act(async () => {
  useInboxStore.getState().syncTable("replyStreams", [{ _id: CONV, conversation_id: CONV, message_id: "hook-b", text, seq, started_at: STARTED, updated_at: Date.now(), received_at: receivedAt }] as any);
  flushSyncPublishes();
});
const tick = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const renders = () => ((w as any).__renderCounts?.() ?? {})["ConversationView2"] ?? 0;
const resizeObserved = () => act(async () => { for (const o of sizeObservers) for (const el of o.targets) if (el.isConnected) o.report(el); });

async function mount(props: { targetMessageId?: string } = {}) {
  const host = w.document.createElement("div");
  w.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
        <MemoryRouter>
          <InboxConversation sessionId={CONV} isIdle={false} autoFocusInput={false} {...props} />
        </MemoryRouter>
      </ConvexProviderWithAuth>,
    );
  });
  const deadline = Date.now() + 20_000;
  while (!host.textContent!.includes("Let me read the sync layer.")) {
    if (Date.now() > deadline) throw new Error("conversation never painted");
    await tick(20);
  }
  // Past ConversationView's first-paint settling window (no slide-ins there).
  await tick(1_600);
  const rowKeys = () => [...host.querySelectorAll<HTMLElement>("[data-vkey]")].map((el) => el.dataset.vkey!);
  const row = (key: string) => host.querySelector<HTMLElement>(`[data-vkey="${key}"]`);
  const feed = () => host.querySelector<HTMLElement>("[data-sv-feed]")!;
  return { host, root, rowKeys, row, feed, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

const STREAM_KEY = "reply-stream:hook-b";
// The wrapper ConversationView puts around a row's content: its padding is
// the gap between rows.
const wrapperClass = (row: HTMLElement | null) => row?.firstElementChild?.className.replace(/\banimate-message-in\b/, "").replace(/\s+/g, " ").trim();
// Each drawn row's key with its row style and wrapper (whether it draws, and its gaps).
const rowLooks = (v: { host: HTMLElement }) =>
  [...v.host.querySelectorAll<HTMLElement>("[data-vkey]")].map((el) => `${el.dataset.vkey} ${el.style.height || "auto"} ${el.style.overflow || ""} ${wrapperClass(el) ?? "-"}`);

beforeEach(() => {
  subscribed = [];
  mutated = [];
});

for (const full of [false, true]) test(`its own row, after the tool result, boxed like the message that replaces it, which keeps the row (${full ? "full" : "condensed"})`, async () => {
  seed(true, { full });
  const v = await mount();
  expect(v.feed().getAttribute("data-cc-density")).toBe(full ? "full" : "condensed");
  expect(subscribed).toContain("replyStreams:get");
  // The lease that lets the server write pushes, taken once on open.
  expect(mutated.filter((m) => m === "replyStreams:watch").length).toBe(1);
  const drawnBefore = rowLooks(v);
  await push(1, "The jump comes from two writes in one frame.");
  const keys = v.rowKeys();
  expect(keys.slice(-2)).toEqual([id(2), STREAM_KEY]);
  // The rows before it draw exactly as they did: the reply's gap is its own.
  expect(rowLooks(v).filter((r) => !r.startsWith(STREAM_KEY))).toEqual(drawnBefore);
  const streamRow = v.row(STREAM_KEY)!;
  // The wrapper an assistant text row gets.
  expect(wrapperClass(streamRow)).toBe(wrapperClass(v.row(id(1))));
  const liveWrapper = wrapperClass(streamRow);
  expect(streamRow.textContent).toContain("The jump comes from two writes in one frame.");
  // Continues the agent's run: no second name header (same author, model, window).
  expect(streamRow.querySelector("[data-cc-message-who]")).toBeNull();

  // The message lands: it takes the reply's row, same node, same wrapper.
  await act(async () => {
    useInboxStore.getState().mergeMessages(CONV, [{ _id: id(4), conversation_id: CONV, role: "assistant", content: "The jump comes from two writes in one frame.\n\nBoth land together.", timestamp: STARTED + 300, model: "claude-opus-4" }] as any, "append");
    flushSyncPublishes();
  });
  expect(v.row(STREAM_KEY)).toBe(streamRow);
  expect(streamRow.isConnected).toBe(true);
  expect(streamRow.textContent).toContain("Both land together.");
  expect(wrapperClass(streamRow)).toBe(liveWrapper);
  expect(streamRow.querySelector("[data-cc-message-who]")).toBeNull();
  expect(streamRow.textContent!.split("The jump comes from").length - 1).toBe(1);
  expect(v.row(id(4))).toBeNull();
  await v.unmount();
});

test("pushes re-render the block, not the conversation view", async () => {
  seed(true);
  const v = await mount();
  await push(1, "First paragraph.");
  await tick(50);
  const before = renders();
  expect(before).toBeGreaterThan(0);
  await push(2, "First paragraph.\n\nSecond paragraph.");
  await push(3, "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
  expect(v.row(STREAM_KEY)!.textContent).toContain("Third paragraph.");
  expect(renders()).toBe(before);
  await v.unmount();
});

test("a message the person sends mid-reply draws below the reply, which keeps its row", async () => {
  seed(true);
  const v = await mount();
  await push(1, "Working through the sync layer now.");
  const streamRow = v.row(STREAM_KEY)!;
  await act(async () => {
    useInboxStore.setState((s: any) => ({ pendingMessages: { ...s.pendingMessages, [CONV]: [{ _id: "pending-1", _clientId: "pending-1", role: "user", content: "Also check the cache", timestamp: STARTED + 5_000, _isOptimistic: true }] } }) as any);
    flushSyncPublishes();
  });
  await tick(20);
  const keys = v.rowKeys();
  const pendingKey = keys.find((k) => k.includes("pending-1"));
  expect(pendingKey).toBeDefined();
  expect(keys.indexOf(STREAM_KEY)).toBeLessThan(keys.indexOf(pendingKey!));
  expect(v.row(STREAM_KEY)).toBe(streamRow);
  await push(2, "Working through the sync layer now.\n\nFound it.");
  expect(v.row(STREAM_KEY)).toBe(streamRow);
  await v.unmount();
});

test("scrolled up inside the reply, its growth moves nothing; at the bottom, the view stays pinned", async () => {
  seed(true);
  const v = await mount();
  await push(1, "x".repeat(1_200));
  await resizeObserved();
  await tick(50);
  const feed = v.feed();
  // At the bottom: growth keeps the end in view.
  feed.scrollTop = 1e9;
  await tick(50);
  await push(2, "x".repeat(1_600));
  await resizeObserved();
  await tick(50);
  expect(feed.scrollTop).toBe(scrollHeightOf(feed) - VIEWPORT);
  // Scrolled up into the reply (its top above the viewport top).
  feed.scrollTop = feed.scrollTop - 300;
  await tick(50);
  const reading = feed.scrollTop;
  await push(3, "x".repeat(2_400));
  await resizeObserved();
  await tick(50);
  expect(feed.scrollTop).toBe(reading);
  await v.unmount();
});

const land = (content: string, extra: Record<string, unknown> = {}) => act(async () => {
  useInboxStore.getState().mergeMessages(CONV, [{ _id: id(9), conversation_id: CONV, role: "assistant", content, timestamp: STARTED + 300, model: "claude-opus-4", ...extra }] as any, "append");
  flushSyncPublishes();
});

for (const full of [false, true]) test(`the message landing taller than the last push moves nothing for a reader scrolled up inside it, and keeps the bottom pinned (${full ? "full" : "condensed"})`, async () => {
  seed(true, { full });
  const v = await mount();
  await push(1, "x".repeat(1_200));
  await resizeObserved();
  await tick(50);
  const feed = v.feed();
  feed.scrollTop = 1e9;
  await tick(50);
  feed.scrollTop = feed.scrollTop - 300;
  await tick(50);
  const reading = feed.scrollTop;
  // The closing paragraph arrives with the message.
  await land("x".repeat(1_200) + "\n\n" + "y".repeat(600));
  await resizeObserved();
  await tick(80);
  expect(v.rowKeys()).toContain(STREAM_KEY);
  expect(feed.scrollTop).toBe(reading);
  await v.unmount();

  seed(true, { full });
  const b = await mount();
  await push(1, "x".repeat(1_200));
  await resizeObserved();
  await tick(50);
  const bottom = b.feed();
  bottom.scrollTop = 1e9;
  await tick(50);
  await land("x".repeat(1_200) + "\n\n" + "y".repeat(600));
  await resizeObserved();
  await tick(80);
  expect(bottom.scrollTop).toBe(scrollHeightOf(bottom) - VIEWPORT);
  await b.unmount();
});

// What the server and the daemon insert into a live conversation at their own
// "now": none of it is the reply's message.
const INSERTED: Record<string, Record<string, unknown>> = {
  "a workflow event": { subtype: "workflow_event", content: JSON.stringify({ __wf: "node_start", node_id: "review", node_label: "Review", node_type: "agent" }) },
  "a scheduled task result": { subtype: "scheduled_task_result", content: "Nightly digest: 3 sessions need you." },
  "an interactive prompt's prose": { message_uuid: "interactive-prompt-s-rs-abc123-prose", content: "The workflow is running; I will report when the review lands." },
  "a limit-dialog banner": { message_uuid: "limit-dialog-s-rs-abc123-492000", content: "You've hit your limit · resets 3pm" },
};
for (const [kind, fields] of Object.entries(INSERTED)) test(`${kind} arriving mid-reply leaves the reply drawn in its own row; the real message still takes it`, async () => {
  seed(true);
  const v = await mount();
  await push(1, "The workflow is running; I will report when the review lands.");
  const streamRow = v.row(STREAM_KEY)!;
  await act(async () => {
    useInboxStore.getState().mergeMessages(CONV, [{ _id: id(7), conversation_id: CONV, role: "assistant", timestamp: STARTED + 2_000, ...fields }] as any, "append");
    flushSyncPublishes();
  });
  await tick(30);
  expect(v.row(STREAM_KEY)).toBe(streamRow);
  expect(streamRow.querySelector('[data-cc-message="assistant"]')?.textContent).toContain("I will report when the review lands.");
  expect(v.rowKeys()).toContain(id(7));
  await push(2, "The workflow is running; I will report when the review lands.\n\nStill going.");
  expect(v.row(STREAM_KEY)!.textContent).toContain("Still going.");
  await land("The workflow is running; I will report when the review lands.\n\nStill going.\n\nDone.");
  expect(v.row(STREAM_KEY)).toBe(streamRow);
  expect(streamRow.textContent).toContain("Done.");
  expect(v.row(id(9))).toBeNull();
  expect(v.rowKeys()).toContain(id(7));
  await v.unmount();
});

test("a stale reply leaves no row and no residue", async () => {
  seed(true);
  const v = await mount();
  const drawnBefore = rowLooks(v);
  await push(1, "A reply that stopped.", Date.now() - 59_000);
  expect(v.rowKeys()).toContain(STREAM_KEY);
  await tick(1_100);
  await act(async () => { tickCoarseClocks(); });
  expect(v.rowKeys()).not.toContain(STREAM_KEY);
  expect(v.host.textContent).not.toContain("A reply that stopped.");
  // Every row draws as before the reply: no strip, no padding left behind.
  expect(rowLooks(v)).toEqual(drawnBefore);
  await v.unmount();
});

test("a stuck reply already old by the server's clock is not drawn on open", async () => {
  seed(true);
  // A row the store took from the server long after its last push.
  useInboxStore.getState().syncTable("replyStreams", [{ _id: CONV, conversation_id: CONV, message_id: "hook-b", text: "Stuck.", seq: 7, started_at: STARTED, updated_at: Date.now() - 10 * 60_000, received_at: Date.now() - 10 * 60_000 + 5_000 }] as any);
  const v = await mount();
  expect(v.rowKeys()).not.toContain(STREAM_KEY);
  await v.unmount();
});

test("nothing in a deep-linked window", async () => {
  seed(true);
  // A message the loaded tail does not hold, so the view stays a window.
  const v = await mount({ targetMessageId: id(99) });
  await push(1, "Written while a window is open.");
  expect(v.rowKeys()).not.toContain(STREAM_KEY);
  expect(v.host.textContent).not.toContain("Written while a window is open.");
  await v.unmount();
});

test("with the flag off the feeder never subscribes", async () => {
  seed(false);
  const v = await mount();
  expect(subscribed).not.toContain("replyStreams:get");
  expect(mutated).not.toContain("replyStreams:watch");
  await v.unmount();
});
