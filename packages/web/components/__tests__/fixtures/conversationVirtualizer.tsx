import { afterAll, expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProviderWithAuth } from "convex/react";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../../test-helpers/globals";
import type { ConversationData } from "../../conversation/types";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const sizes = new WeakMap<Element, number>();
let onHeightRead: ((el: HTMLElement) => void) | undefined;
const offsets = new WeakMap<Element, number>();
const observers = new Set<TestResizeObserver>();
// A background tab pane is display:none: nothing in it has a box.
let paneHidden = false;
let scrollerReads = 0;
// A row's height by its key, for a test whose rows unmount and mount again.
const keyedSizes = new Map<string, number>();
const height = (el: Element) => paneHidden || (el as HTMLElement).style.height === "0px" ? 0 : sizes.get(el) ?? keyedSizes.get((el as HTMLElement).dataset?.vkey ?? "") ?? (el.hasAttribute("data-sv-feed") ? 500 : 50);
/** Every observer reports each of its targets again, as a browser does when a pane hides or shows. */
const reportAllBoxes = () => {
  for (const observer of [...observers]) {
    const entries = [...observer.targets].filter((el) => el.isConnected).map((el) => ({ target: el, contentRect: { width: paneHidden ? 0 : 700, height: height(el) }, borderBoxSize: [{ blockSize: height(el), inlineSize: paneHidden ? 0 : 700 }] }));
    if (entries.length) observer.callback(entries as unknown as ResizeObserverEntry[], observer as unknown as ResizeObserver);
  }
};
class TestResizeObserver {
  targets = new Set<Element>();
  constructor(public callback: ResizeObserverCallback) { observers.add(this); }
  observe(el: Element) {
    this.targets.add(el);
    queueMicrotask(() => {
      if (this.targets.has(el) && el.isConnected) this.callback([{ target: el, borderBoxSize: [{ blockSize: height(el), inlineSize: 700 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    });
  }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); observers.delete(this); }
}
Object.defineProperties(dom.window.HTMLElement.prototype, {
  scrollTop: {
    get() { return offsets.get(this) ?? 0; },
    set(value: number) {
      const next = Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight)));
      if (next === (offsets.get(this) ?? 0)) return;
      offsets.set(this, next);
      queueMicrotask(() => { if (this.isConnected) this.dispatchEvent(new dom.window.Event("scroll")); });
    },
  },
  offsetHeight: { get() { onHeightRead?.(this); return height(this); } },
  offsetWidth: { get() { return 700; } },
  clientHeight: { get() { if (this.hasAttribute("data-sv-feed")) scrollerReads++; return height(this); } },
  clientWidth: { get() { return 700; } },
  scrollHeight: { get() { if (this.hasAttribute("data-sv-feed")) scrollerReads++; return this.hasAttribute("data-sv-feed") ? Number.parseFloat(this.querySelector("[data-vkey]")?.parentElement.style.height ?? "500") : height(this); } },
  offsetParent: { get() { return dom.window.document.body; } },
});
dom.window.HTMLElement.prototype.getBoundingClientRect = function () { const width = paneHidden ? 0 : 700; return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height(this), width, height: height(this), toJSON() {} }; };
dom.window.HTMLElement.prototype.scrollTo = function (x: any, y?: number) { this.scrollTop = typeof x === "object" ? x.top ?? this.scrollTop : y ?? 0; };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
(dom.window as any).ResizeObserver = TestResizeObserver;
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const restore = replaceGlobals({ window: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, DOMRect: dom.window.DOMRect, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: TestResizeObserver, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
afterAll(() => { dom.window.close(); restore(); });
const { ConversationView } = await import("../../ConversationView");
const { useInboxStore } = await import("../../../store/inboxStore");
const useAuth = () => ({ isLoading: false, isAuthenticated: false, fetchAccessToken: async () => null });
const client = { clearAuth() {}, setAuth() {}, watchQuery() { return { onUpdate() { return () => {}; }, localQueryResult() { return undefined; }, journal() { return undefined; } }; }, connectionState() { return { isWebSocketConnected: true }; }, subscribeToConnectionState() { return () => {}; }, mutation() { throw Error("Unexpected mutation"); }, query() { return Promise.resolve(undefined); } } as any;
const empty: never[] = [];
const conversation: ConversationData = { _id: "perf-fixture" as any, title: "Resize fixture", messages: Array.from({ length: 80 }, (_, i) => ({ _id: `perf-row-${i}`, role: "assistant", timestamp: 1_000_000 + i * 1000, content: `Message ${i}` })), message_count: 800, agent_type: "codex", status: "completed" };

for (const messageCount of [80, 800]) test(`a measured row resize keeps geometry and progress current for ${messageCount} messages`, async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const errors = spyOn(console, "error");
  let commits = 0;
  try {
    await act(async () => { root.render(<ConvexProviderWithAuth client={client} useAuth={useAuth}><MemoryRouter><Profiler id="transcript" onRender={() => commits++}><ConversationView conversation={{ ...conversation, _id: `fixture-${messageCount}` as any, messages: conversation.messages.map(m => ({ ...m, _id: `${messageCount}-${m._id}` })), message_count: messageCount }} commits={empty} pullRequests={empty} backHref="/" hideHeader showMessageInput={false} isOwner={false} /></Profiler></MemoryRouter></ConvexProviderWithAuth>); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(errors.mock.calls.filter((args) => args.some((arg) => String(arg).includes("flushSync was called")))).toEqual([]);
    const feed = host.querySelector<HTMLElement>("[data-sv-feed]")!;
    await act(async () => {
      feed.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -800, bubbles: true }));
      feed.scrollTop -= 800;
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    const rows = [...host.querySelectorAll<HTMLElement>("[data-vkey]")];
    expect(rows.length).toBeGreaterThan(2);
    const row = rows.at(-2)!;
    const container = row.parentElement!;
    const resize = async () => act(async () => {
      sizes.set(row, height(row) + 8);
      for (const observer of observers) if (observer.targets.has(row)) observer.callback([{ target: row, borderBoxSize: [{ blockSize: height(row), inlineSize: 700 }] } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
    });
    await resize();
    const beforeHeight = Number.parseFloat(container.style.height);
    const beforeCommits = commits;
    await resize();
    expect(Number.parseFloat(container.style.height)).toBe(beforeHeight + 8);
    const progress = host.querySelector<HTMLElement>("[data-cc-scroll-progress]");
    expect(progress).not.toBeNull();
    if (messageCount > 150) {
      expect(commits).toBe(beforeCommits);
    } else {
      expect(Number.parseFloat(progress!.style.height)).toBeCloseTo(feed.scrollTop / (feed.scrollHeight - feed.clientHeight) * 100, 2);
    }
  } finally { await act(() => root.unmount()); host.remove(); errors.mockRestore(); }
}, 30_000);

test("a pane that hides and comes back keeps every row's height and place, and reads no layout for a reader mid-transcript", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let commits = 0;
  try {
    await act(async () => { root.render(<ConvexProviderWithAuth client={client} useAuth={useAuth}><MemoryRouter><Profiler id="transcript" onRender={() => commits++}><ConversationView conversation={{ ...conversation, _id: "hidden-pane-fixture" as any, messages: conversation.messages.map(m => ({ ...m, _id: `hidden-${m._id}` })), message_count: 800 }} commits={empty} pullRequests={empty} backHref="/" hideHeader showMessageInput={false} isOwner={false} /></Profiler></MemoryRouter></ConvexProviderWithAuth>); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    const feed = host.querySelector<HTMLElement>("[data-sv-feed]")!;
    // The reader wheels up into the middle of the transcript: a load is armed
    // and stays armed, far from the top.
    await act(async () => {
      feed.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -800, bubbles: true }));
      feed.scrollTop -= 800;
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    const rows = [...host.querySelectorAll<HTMLElement>("[data-vkey]")];
    expect(rows.length).toBeGreaterThan(2);
    const container = rows[0].parentElement!;
    // Rows of different heights, so a lost measurement shows.
    await act(async () => {
      rows.forEach((row, i) => keyedSizes.set(row.dataset.vkey!, 60 + (i % 5) * 20));
      reportAllBoxes();
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    const placed = () => [...host.querySelectorAll<HTMLElement>("[data-vkey]")].map((row) => `${row.dataset.vkey}@${row.style.top}`).join(" ");
    const heightBefore = container.style.height;
    const placedBefore = placed();
    const offsetBefore = feed.scrollTop;
    expect(Number.parseFloat(heightBefore)).toBeGreaterThan(500);
    expect(feed.scrollTop).toBeGreaterThan(1200);

    // The tab goes to the background.
    const commitsBefore = commits;
    scrollerReads = 0;
    await act(async () => {
      paneHidden = true;
      reportAllBoxes();
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    // A pane with no viewport draws no rows; what it must keep is their heights.
    expect(container.style.height).toBe(heightBefore);

    // And comes back.
    await act(async () => {
      paneHidden = false;
      reportAllBoxes();
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    expect(container.style.height).toBe(heightBefore);
    expect(placed()).toBe(placedBefore);
    expect(feed.scrollTop).toBe(offsetBefore);
    // No row lost its height, so no row was measured again: nothing to commit
    // per row, and the armed load never read the page.
    expect(commits - commitsBefore).toBeLessThanOrEqual(4);
    expect(scrollerReads).toBeLessThanOrEqual(6);
  } finally { paneHidden = false; keyedSizes.clear(); await act(() => root.unmount()); host.remove(); }
}, 30_000);

test("size repair reads all row heights before changing geometry", async () => {
  const interval = globalThis.setInterval;
  const ticks: (() => void)[] = [];
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay === 1000) ticks.push(callback);
    return interval(callback, delay === 1000 ? 60_000 : delay, ...args);
  }) as typeof setInterval);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<ConvexProviderWithAuth client={client} useAuth={useAuth}><MemoryRouter><ConversationView conversation={{ ...conversation, _id: "repair-fixture" as any }} commits={empty} pullRequests={empty} backHref="/" hideHeader showMessageInput={false} isOwner={false} /></MemoryRouter></ConvexProviderWithAuth>); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    const feed = host.querySelector<HTMLElement>("[data-sv-feed]")!;
    await act(async () => {
      feed.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -800, bubbles: true }));
      feed.scrollTop -= 800;
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    const rows = [...host.querySelectorAll<HTMLElement>("[data-vkey]")];
    expect(rows.length).toBeGreaterThan(2);
    const container = rows[0].parentElement!;
    const tracked = new Set(rows);
    const parentHeights: string[] = [];
    for (const row of rows) sizes.set(row, height(row) + 8);
    onHeightRead = el => { if (tracked.has(el)) parentHeights.push(container.style.height); };
    await act(async () => { feed.dispatchEvent(new dom.window.Event("scrollend")); await new Promise(resolve => setTimeout(resolve, 200)); });
    await act(async () => {
      for (const tick of ticks) tick();
      onHeightRead = undefined;
    });
    expect(parentHeights.length).toBe(rows.length);
    expect(new Set(parentHeights).size).toBe(1);
    expect(container.style.height).not.toBe(parentHeights[0]);
  } finally {
    onHeightRead = undefined;
    await act(() => root.unmount()); host.remove(); timer.mockRestore();
  }
}, 30_000);

test("fold mode draws the person's message and what the agent said, as bubbles, and nothing else", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const say = { id: "say-1", name: "Bash", input: JSON.stringify({ command: `cast say "One funnel: introductions per week."` }) };
  const data = { ...conversation, _id: "fold-clean" as any, messages: [
    { _id: "clean-u1", role: "user", timestamp: 1_000_000, content: "What is your focus?" },
    { _id: "clean-a1", role: "assistant", timestamp: 1_001_000, content: "Let me look at the funnel first.", tool_calls: [say] },
    { _id: "clean-a2", role: "assistant", timestamp: 1_002_000, content: "Said it." },
  ] } as any;
  const view = <ConvexProviderWithAuth client={client} useAuth={useAuth}><MemoryRouter><ConversationView conversation={data} commits={empty} pullRequests={empty} backHref="/" hideHeader showMessageInput={false} isOwner={false} initialDensity="condensed" foldWorkingTurns openAtTop /></MemoryRouter></ConvexProviderWithAuth>;
  const anchors = (useInboxStore.getState() as any).anchors;
  try {
    // The page asks for fold mode; the seat's own switch decides it.
    await act(async () => { root.render(view); });
    expect(host.textContent).toContain("Let me look at the funnel first.");
    await act(async () => { useInboxStore.setState({ anchors: { ...anchors, "seat-fold": { _id: "seat-fold", conversation_id: "fold-clean", clean_chat: true } } } as any); });
    expect(host.textContent).toContain("What is your focus?");
    expect(host.textContent).toContain("One funnel: introductions per week.");
    expect(host.textContent).not.toContain("Let me look at the funnel first.");
    expect(host.textContent).not.toContain("Said it.");
    expect(host.querySelectorAll("[data-cc-bubble]").length).toBe(2);
  } finally { useInboxStore.setState({ anchors } as any); await act(() => root.unmount()); host.remove(); }
}, 30_000);
