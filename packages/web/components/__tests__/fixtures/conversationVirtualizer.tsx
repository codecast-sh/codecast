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
const height = (el: Element) => (el as HTMLElement).style.height === "0px" ? 0 : sizes.get(el) ?? (el.hasAttribute("data-sv-feed") ? 500 : 50);
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
  clientHeight: { get() { return height(this); } },
  clientWidth: { get() { return 700; } },
  scrollHeight: { get() { return this.hasAttribute("data-sv-feed") ? Number.parseFloat(this.querySelector("[data-vkey]")?.parentElement.style.height ?? "500") : height(this); } },
  offsetParent: { get() { return dom.window.document.body; } },
});
dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, top: 0, left: 0, right: 700, bottom: height(this), width: 700, height: height(this), toJSON() {} }; };
dom.window.HTMLElement.prototype.scrollTo = function (x: any, y?: number) { this.scrollTop = typeof x === "object" ? x.top ?? this.scrollTop : y ?? 0; };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
(dom.window as any).ResizeObserver = TestResizeObserver;
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const restore = replaceGlobals({ window: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, DOMRect: dom.window.DOMRect, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: TestResizeObserver, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
afterAll(() => { dom.window.close(); restore(); });
const { ConversationView } = await import("../../ConversationView");
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

test("folding a turn clears the space held by off-screen replies immediately", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let data = { ...conversation, _id: "fold-spacing" as any };
  const render = (foldWorkingTurns: boolean) => root.render(
    <ConvexProviderWithAuth client={client} useAuth={useAuth}><MemoryRouter><ConversationView conversation={data} commits={empty} pullRequests={empty} backHref="/" hideHeader showMessageInput={false} isOwner={false} initialDensity="full" foldWorkingTurns={foldWorkingTurns} openAtTop /></MemoryRouter></ConvexProviderWithAuth>,
  );
  try {
    await act(async () => { render(false); });
    const feed = host.querySelector<HTMLElement>("[data-sv-feed]")!;
    const firstRow = host.querySelector<HTMLElement>('[data-index="0"]')!;
    expect(firstRow).not.toBeNull();
    await act(async () => { feed.scrollTop = feed.scrollHeight; });
    expect(firstRow.isConnected).toBe(false);
    await act(async () => { render(true); });
    const container = host.querySelector<HTMLElement>("[data-vkey]")!.parentElement!;
    expect(Number.parseFloat(container.style.height)).toBeLessThan(400);
    expect(host.textContent).toContain("Message 79");
    data = { ...data, messages: [...data.messages, { _id: "fold-spacing-next", role: "assistant", timestamp: 2_000_000, content: "The next reply" }] };
    await act(async () => { render(true); });
    expect(Number.parseFloat(container.style.height)).toBeLessThan(400);
    expect(host.textContent).toContain("The next reply");
    expect(host.textContent).not.toContain("Message 79");
    await act(async () => { render(false); });
    expect(Number.parseFloat(container.style.height)).toBeGreaterThan(1000);
  } finally { await act(() => root.unmount()); host.remove(); }
}, 30_000);
