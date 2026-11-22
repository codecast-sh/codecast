// A reply sent from a paged transcript lands on screen (ct-97968).
//
// Opened at a deep link or a search hit, the transcript is a window around
// that message: newer pages are not loaded (`hasMoreBelow`), so "Scroll to
// bottom" shows. Sending a reply from there used to scroll only to the end of
// the loaded window, short of the reply, and the person scrolled down by hand.
// Here the real conversation pane (InboxConversation → ConversationView, its
// composer and its virtualized feed) is mounted over a paged window; the reply
// is typed into the composer and sent with Enter. The send must leave the
// window for the live end, and once the live page lands the reply is drawn at
// the bottom of the feed and "Scroll to bottom" is hidden.
//
// Only the message source is faked: useConversationMessages hands out a
// window this file controls, and its jumpToEnd swaps in the live tail the way
// the real hook does when it leaves target mode.
// Run: bun test components/__tests__/sendLandsOnLiveEnd.mount.test.tsx
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://app.test/inbox", pretendToBeVisual: true });
const w = dom.window as any;

// jsdom lays nothing out. Rows are 50px and the feed a viewport of 800px, so
// the virtualizer windows itself and scrollTop means what it does in a browser
// (the perf harness's geometry, perf/harness.tsx).
const ROW = 50;
const VIEWPORT = 800;
const offsets = new WeakMap<Element, number>();
const isFeed = (el: Element) => el.hasAttribute("data-sv-feed");
const heightOf = (el: Element) => ((el as HTMLElement).style?.height === "0px" ? 0 : isFeed(el) ? VIEWPORT : ROW);
const scrollHeightOf = (el: Element) => isFeed(el) ? Math.max(VIEWPORT, Number.parseFloat(el.querySelector<HTMLElement>('div[style*="position: relative"][style*="height"]')?.style.height || "0")) : heightOf(el);
Object.defineProperties(w.HTMLElement.prototype, {
  offsetHeight: { get(this: HTMLElement) { return heightOf(this); }, configurable: true },
  offsetWidth: { get: () => 700, configurable: true },
  clientHeight: { get(this: HTMLElement) { return heightOf(this); }, configurable: true },
  clientWidth: { get: () => 700, configurable: true },
  scrollHeight: { get(this: HTMLElement) { return scrollHeightOf(this); }, configurable: true },
  scrollWidth: { get: () => 700, configurable: true },
  offsetTop: { get: () => 0, configurable: true },
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
class SizeObserver {
  targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) {}
  observe(el: Element) {
    this.targets.add(el);
    queueMicrotask(() => {
      if (this.targets.has(el) && el.isConnected) this.callback([{ target: el, contentRect: { height: heightOf(el), width: 700 }, contentBoxSize: [{ blockSize: heightOf(el), inlineSize: 700 }], borderBoxSize: [{ blockSize: heightOf(el), inlineSize: 700 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    });
  }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}
w.ResizeObserver = SizeObserver;
w.IntersectionObserver = NoopObserver;
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const restoreGlobals = replaceGlobals({
  window: w, document: w.document, navigator: w.navigator, localStorage: w.localStorage, sessionStorage: w.sessionStorage,
  location: w.location, history: w.history, indexedDB, IDBKeyRange,
  HTMLElement: w.HTMLElement, HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLInputElement: w.HTMLInputElement, HTMLAnchorElement: w.HTMLAnchorElement,
  Element: w.Element, Node: w.Node, Text: w.Text, Document: w.Document, DocumentFragment: w.DocumentFragment, SVGElement: w.SVGElement,
  Event: w.Event, CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, WheelEvent: w.WheelEvent, FocusEvent: w.FocusEvent,
  MutationObserver: w.MutationObserver, DOMRect: w.DOMRect, DOMParser: w.DOMParser, customElements: w.customElements, getComputedStyle: w.getComputedStyle.bind(w),
  ResizeObserver: SizeObserver, IntersectionObserver: NoopObserver, matchMedia: w.matchMedia,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0),
  cancelAnimationFrame: (id: any) => clearTimeout(id),
  requestIdleCallback: (cb: any) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0),
  cancelIdleCallback: (id: any) => clearTimeout(id),
  CSS: { escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"), supports: () => false },
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const React = await import("react");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

const CONV = "jx7000000000000000000000livend01"; // 32 chars => isConvexId
const ME = "user_live_end";
const NOW = Date.UTC(2026, 10, 22, 12);
const REPLY = "Thanks, ship it from here";

const msg = (i: number, extra: Record<string, unknown> = {}) => ({
  _id: `${CONV.slice(0, 20)}m${String(i).padStart(11, "0")}`, conversation_id: CONV,
  role: i % 2 === 0 ? "user" : "assistant", timestamp: NOW - (400 - i) * 30_000,
  content: i % 2 === 0 ? `Prompt ${i}` : `Answer ${i}`, ...extra,
});
// The window around a search hit (messages 40..79 of 200), and the live tail
// once the jump lands: the last 80 messages and the reply just sent.
const PAGED = Array.from({ length: 40 }, (_, k) => msg(40 + k));
const LIVE = [...Array.from({ length: 80 }, (_, k) => msg(120 + k)), msg(200, { role: "user", content: REPLY })];

// The message source: a window this file swaps, read through
// useSyncExternalStore so a swap re-renders the pane as the real hook does.
type Win = { messages: any[]; hasMoreBelow: boolean; isLoadingNewer: boolean; target?: string };
let win: Win = { messages: PAGED, hasMoreBelow: true, isLoadingNewer: false, target: PAGED[10]._id };
const listeners = new Set<() => void>();
const setWin = (next: Partial<Win>) => { win = { ...win, ...next }; listeners.forEach((l) => l()); };
const jumps: string[] = [];
const conversation = (w2: Win) => ({
  _id: CONV, session_id: "s-live-end", user_id: ME, is_own: true, status: "active", agent_type: "claude_code",
  title: "Live end", started_at: NOW - 86_400_000, updated_at: NOW, message_count: 201, messages: w2.messages,
});
const convs = new WeakMap<Win, any>();
const realMessages = { ...(await import("../../hooks/useConversationMessages")) };
mock.module("../../hooks/useConversationMessages", () => ({
  ...realMessages,
  useConversationMessages: () => {
    const cur = React.useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => win);
    if (!convs.has(cur)) convs.set(cur, conversation(cur));
    return {
      conversation: convs.get(cur),
      hasMoreAbove: true, hasMoreBelow: cur.hasMoreBelow, isLoadingOlder: false, isLoadingNewer: cur.isLoadingNewer,
      loadOlder: () => {}, loadNewer: () => {}, jumpToStart: () => {}, jumpToTimestamp: () => {},
      // Leaving target mode: the live tail loads, then replaces the window.
      jumpToEnd: () => {
        jumps.push("end");
        setWin({ isLoadingNewer: true });
        setTimeout(() => setWin({ messages: LIVE, hasMoreBelow: false, isLoadingNewer: false, target: undefined }), 30);
      },
      isSearchingForTarget: false, targetMessageFound: !!cur.target, effectiveTargetMessageId: cur.target,
      isJumpingToTarget: false, targetMode: cur.hasMoreBelow,
    };
  },
}));
mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});

const { ConvexProviderWithAuth } = await import("convex/react");
const useAuth = () => ({ isLoading: false, isAuthenticated: true, fetchAccessToken: async () => "test" });
const { MemoryRouter } = await import("react-router");
const { createRoot } = await import("react-dom/client");
const { offlineConvexClient } = await import("../../test-helpers/offlineConvex");
const { useInboxStore } = await import("../../store/inboxStore");
const { InboxConversation } = await import("../../app/inbox/QueuePageClient");

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = () => new Promise(() => {});
  (client as any).action = async () => null;
  (client as any).setAuth = () => {};
  (client as any).clearAuth = () => {};
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

const tick = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function until(check: () => boolean, what: string, maxMs = 20_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > maxMs) throw new Error(`timed out waiting for ${what}`);
    await tick(20);
  }
}
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const feed = () => q("[data-sv-feed]")!;
const scrollToBottom = () => q<HTMLButtonElement>('button[aria-label="Scroll to bottom"], button[aria-label="Cancel jump to bottom"]');
const atBottom = () => { const f = feed(); return f.scrollHeight - f.clientHeight - f.scrollTop <= 1; };
// The textarea's own key handler, called as React would: a dispatched keydown
// trips React's IE input polyfill under jsdom (composerEscapeStops.mount.test).
const reactProps = (el: Element) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!];

test("a reply sent from a paged window lands at the live end, with Scroll to bottom hidden", async () => {
  const dispatched: string[] = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string) => { dispatched.push(action); return undefined; });
  useInboxStore.setState({
    sessions: { [CONV]: { _id: CONV, session_id: "s-live-end", user_id: ME, title: "Live end", agent_type: "claude_code", status: "active", is_idle: true, agent_status: "idle", message_count: 201, updated_at: NOW, started_at: NOW - 86_400_000 } },
    conversations: {}, pendingMessages: {}, drafts: {},
    currentUser: { _id: ME, name: "Reader" }, clientStateInitialized: true,
  } as any);
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      <ConvexProviderWithAuth client={fakeConvex()} useAuth={useAuth}>
        <MemoryRouter><InboxConversation sessionId={CONV} isIdle autoFocusInput={false} targetMessageId={PAGED[10]._id} /></MemoryRouter>
      </ConvexProviderWithAuth>,
    );
  });
  await until(() => !!q("[data-sv-feed]") && !!q("[data-composer-field]"), "the pane to draw");
  await tick(200);

  // Opened at the hit: newer pages unloaded, so Scroll to bottom shows.
  expect(scrollToBottom()?.getAttribute("aria-hidden")).toBeNull();
  expect(feed().textContent).not.toContain(REPLY);

  const field = q<HTMLTextAreaElement>("[data-composer-field]")!;
  await act(async () => { reactProps(field).onChange({ target: { value: REPLY }, currentTarget: { value: REPLY } }); });
  await act(async () => {
    reactProps(field).onKeyDown({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, nativeEvent: { isComposing: false }, currentTarget: field, target: field });
  });

  await until(() => dispatched.includes("sendMessage"), "the composer to send the reply");
  await until(() => jumps.length > 0, "the send to leave the paged window", 5_000);
  await until(() => win.messages === LIVE && feed().textContent!.includes(REPLY), "the live tail to draw the reply");
  await tick(700);

  expect(jumps).toEqual(["end"]);
  expect(atBottom()).toBe(true);
  const button = scrollToBottom()!;
  expect(button.getAttribute("aria-hidden")).toBe("true");
  expect(button.className).toContain("opacity-0");
  await act(async () => root.unmount());
}, 120_000);
