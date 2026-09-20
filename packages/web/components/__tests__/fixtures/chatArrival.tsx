import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { replaceGlobals } from "../../../test-helpers/globals";
import type { ChatMessageView } from "../../chat/chatTypes";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const offsets = new WeakMap<Element, number>();
const height = (el: Element) => el.classList.contains("ch-list") ? 400 : el.getAttribute("data-vkey")?.includes("tall") ? 900 : 50;
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
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
  scrollHeight: { get() { return this.classList.contains("ch-list") ? Math.max(400, Number.parseFloat(this.querySelector(".ch-list-sizer")?.style.height ?? "400")) : height(this); } },
  offsetParent: { get() { return dom.window.document.body; } },
});
dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, top: 0, left: 0, right: 700, bottom: height(this), width: 700, height: height(this), toJSON() {} }; };
dom.window.HTMLElement.prototype.scrollTo = function (x: any, y?: number) { this.scrollTop = typeof x === "object" ? x.top ?? this.scrollTop : y ?? 0; };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
(dom.window as any).ResizeObserver = TestResizeObserver;
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const restore = replaceGlobals({ window: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, DOMRect: dom.window.DOMRect, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: TestResizeObserver, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
afterAll(() => { dom.window.close(); restore(); });
const { ChatMessageList } = await import("../../chat/ChatMessageList");
const now = Date.now();
const message = (i: number, overrides: Partial<ChatMessageView> = {}): ChatMessageView => ({ id: `message-${i}`, author: { id: "other", name: "Teammate" }, content: `Message ${i}`, createdAt: now + i, ...overrides });
const pause = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const nextFrame = () => act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });

for (const inThread of [false, true]) test(`incoming messages immediately pin ${inThread ? "a thread" : "a channel"}, even while scrolled away`, async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let messages = Array.from({ length: 40 }, (_, i) => message(i));
  const render = () => act(async () => root.render(<ChatMessageList messages={messages} viewerId="me" channelId={`arrival-${inThread}`} now={now} inThread={inThread}/>));
  try {
    await render();
    await pause(1050);
    const feed = host.querySelector<HTMLElement>(".ch-list")!;
    await act(async () => { feed.scrollTop = 600; feed.dispatchEvent(new Event("scroll")); });
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeGreaterThan(500);
    messages = [...messages, message(40)];
    await render();
    await nextFrame();
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeLessThanOrEqual(1);
    messages = [...messages, message(41, { id: "tall", content: "A tall incoming message.\n\n".repeat(80) })];
    await render();
    await pause(700);
    await nextFrame();
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeLessThanOrEqual(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
}, 15000);

test("edits and older pages preserve history, while equal-timestamp arrivals pin", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let messages = Array.from({ length: 40 }, (_, i) => message(i));
  let channelId = "history-fixture";
  let targetMessageId: string | undefined;
  const render = () => act(async () => root.render(<ChatMessageList messages={messages} viewerId="me" channelId={channelId} targetMessageId={targetMessageId} now={now}/>));
  try {
    await render();
    await pause(1050);
    const feed = host.querySelector<HTMLElement>(".ch-list")!;
    await act(async () => { feed.scrollTop = 600; feed.dispatchEvent(new Event("scroll")); });
    messages = messages.map(m => m.id === "message-39" ? { ...m, content: "Edited" } : m);
    await render();
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeGreaterThan(500);
    messages = [message(-1), ...messages];
    await render();
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeGreaterThan(500);
    messages = [...messages, message(40, { createdAt: now + 39 })];
    await render();
    await nextFrame();
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeLessThanOrEqual(1);
    channelId = "linked-room";
    targetMessageId = "message-10";
    messages = Array.from({ length: 40 }, (_, i) => message(i));
    await render();
    await pause(700);
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeGreaterThan(500);
    messages = [...messages, message(41)];
    await render();
    await nextFrame();
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeLessThanOrEqual(1);
    await pause(700);
    await act(async () => { feed.scrollTop = 500; feed.dispatchEvent(new Event("scroll")); });
    messages = [...messages, message(42, { author: { id: "me", name: "Me" }, pending: true })];
    await render();
    await nextFrame();
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeLessThanOrEqual(1);
    await act(async () => { feed.scrollTop = 500; feed.dispatchEvent(new Event("scroll")); });
    await pause(700);
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeGreaterThan(500);
  } finally { await act(async () => root.unmount()); host.remove(); }
}, 15000);
