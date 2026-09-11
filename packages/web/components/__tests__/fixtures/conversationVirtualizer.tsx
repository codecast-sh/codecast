import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../../test-helpers/globals";
import { ConversationView, type ConversationData } from "../../ConversationView";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const sizes = new WeakMap<Element, number>();
const offsets = new WeakMap<Element, number>();
const observers = new Set<TestResizeObserver>();
const height = (el: Element) => sizes.get(el) ?? (el.hasAttribute("data-sv-feed") ? 500 : 50);
class TestResizeObserver {
  targets = new Set<Element>();
  constructor(public callback: ResizeObserverCallback) { observers.add(this); }
  observe(el: Element) { this.targets.add(el); }
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
  offsetHeight: { get() { return height(this); } },
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
const client = { watchQuery() { return { onUpdate() { return () => {}; }, localQueryResult() { return undefined; }, journal() { return undefined; } }; }, connectionState() { return { isWebSocketConnected: true }; }, subscribeToConnectionState() { return () => {}; }, mutation() { throw Error("Unexpected mutation"); }, query() { return Promise.resolve(undefined); } } as any;
const empty: never[] = [];
const conversation: ConversationData = { _id: "perf-fixture" as any, title: "Resize fixture", messages: Array.from({ length: 80 }, (_, i) => ({ _id: `perf-row-${i}`, role: "assistant", timestamp: 1_000_000 + i * 1000, content: `Message ${i}` })), message_count: 800, agent_type: "codex", status: "completed" };

for (const messageCount of [80, 800]) test(`a measured row resize keeps geometry and progress current for ${messageCount} messages`, async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let commits = 0;
  try {
    await act(async () => { root.render(<ConvexProvider client={client}><MemoryRouter><Profiler id="transcript" onRender={() => commits++}><ConversationView conversation={{ ...conversation, _id: `fixture-${messageCount}` as any, messages: conversation.messages.map(m => ({ ...m, _id: `${messageCount}-${m._id}` })), message_count: messageCount }} commits={empty} pullRequests={empty} backHref="/" hideHeader showMessageInput={false} isOwner={false} /></Profiler></MemoryRouter></ConvexProvider>); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
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
  } finally { await act(() => root.unmount()); host.remove(); }
});
