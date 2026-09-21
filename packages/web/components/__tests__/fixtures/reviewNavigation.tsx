import { afterAll, expect, test } from "bun:test";
import { act, createRef } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { useInboxStore } from "../../../store/inboxStore";
import { ReviewBar } from "../../ReviewBar";
import { ReviewComposerContext } from "../../reviewContext";
import { jumpToReviewComment, ReviewScrollIndicators } from "../../ReviewNavigation";
import type { PendingComment } from "../../../lib/quoteFormat";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
afterAll(() => { dom.window.close(); restore(); });
const comment = (id: string, messageId: string, blockIndex = 0): PendingComment => ({ id, messageId, blockIndex, quote: `Quoted ${id}`, body: `Reply ${id}`, createdAt: 1 });
const bounds = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON() {} });

test("tray clicks jump to their passage without clearing the batch; removal stays separate", async () => {
  const item = comment("one", "m1", 1);
  useInboxStore.setState({ reviewComments: { c1: [item] } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const jumps: PendingComment[] = [];
  try {
    await act(() => root.render(<ReviewComposerContext.Provider value={{ quote() {}, submit() {}, jumpToComment: c => jumps.push(c) }}><ReviewBar conversationId="c1" /></ReviewComposerContext.Provider>));
    const button = host.querySelector<HTMLButtonElement>(".cc-review-tray-jump")!;
    expect(button.type).toBe("button");
    await act(() => button.click());
    expect(jumps).toEqual([item]);
    expect(useInboxStore.getState().reviewComments.c1).toEqual([item]);
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove this quote"]')!.click());
    expect(jumps).toHaveLength(1);
    expect(host.querySelector(".cc-review-tray")).toBeNull();
  } finally { await act(() => root.unmount()); host.remove(); }
});

test("mounted passage navigation is scoped to its pane, repeatable, and preserves drafts", () => {
  const scroll = document.createElement("div");
  scroll.innerHTML = '<div data-review-message="m1" tabindex="-1"><div class="cc-content"><p>First</p><p>Second</p></div></div>';
  document.body.append(scroll);
  const item = comment("one", "m1", 1);
  const calls: string[] = [];
  const block = scroll.querySelectorAll<HTMLElement>("p")[1];
  block.scrollIntoView = () => { calls.push("passage"); };
  useInboxStore.setState({ reviewComments: { c1: [item] }, reviewEditingId: "one" });
  jumpToReviewComment(item, scroll, id => calls.push(id));
  jumpToReviewComment(item, scroll, id => calls.push(id));
  expect(calls).toEqual(["passage", "passage"]);
  expect(useInboxStore.getState().reviewMessageId).toBe("m1");
  expect(useInboxStore.getState().reviewActiveBlock).toBe(1);
  expect(useInboxStore.getState().reviewEditingId).toBeNull();
  expect(document.activeElement).toBe(scroll.firstElementChild);
  expect(useInboxStore.getState().reviewComments.c1).toEqual([item]);
  jumpToReviewComment(comment("plan", "unmounted#plan", 3), scroll, id => calls.push(id));
  expect(calls.at(-1)).toBe("unmounted");
  expect(useInboxStore.getState().reviewMessageId).toBe("unmounted#plan");
  scroll.remove();
});

test("indicators count offscreen replies and jump to the nearest in transcript order", async () => {
  const scroll = document.createElement("div"); document.body.append(scroll);
  Object.defineProperty(scroll, "clientHeight", { value: 400 });
  scroll.getBoundingClientRect = () => bounds(0, 400);
  scroll.scrollTop = 500;
  const scrollRef = createRef<HTMLDivElement>(); scrollRef.current = scroll;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const farUp = comment("farUp", "m0");
  const nearUp = comment("nearUp", "m1", 8);
  const earlierUp = comment("earlierUp", "m1", 2);
  const nearDown = comment("nearDown", "m3", 2);
  const laterDown = comment("laterDown", "m3", 8);
  const farDown = comment("farDown", "m4");
  const visible = comment("visible", "m2");
  const comments = [farDown, nearUp, visible, laterDown, earlierUp, nearDown, farUp];
  const jumps: string[] = [];
  const virtualizer = { measurementsCache: [0, 250, 500, 1000, 1250].map((start) => ({ start, end: start + 200 })) } as any;
  const render = (conversationId: string) => act(() => root.render(<ReviewComposerContext.Provider value={{ quote() {}, submit() {}, jumpToComment: c => jumps.push(c.id) }}><ReviewScrollIndicators conversationId={conversationId} scrollRef={scrollRef} messageIds={["m0", "m1", "m2", "m3", "m4"]} virtualizer={virtualizer} /></ReviewComposerContext.Provider>));
  useInboxStore.setState({ reviewComments: { c1: comments } });
  try {
    await render("c1");
    expect(host.textContent).toBe("3 replies above3 replies below");
    await act(() => host.querySelector<HTMLButtonElement>('[data-direction="above"]')!.click());
    await act(() => host.querySelector<HTMLButtonElement>('[data-direction="below"]')!.click());
    expect(jumps).toEqual(["nearUp", "nearDown"]);
    const card = document.createElement("div"); card.dataset.reviewComment = "nearUp";
    card.getBoundingClientRect = () => bounds(100, 160); scroll.append(card);
    await act(async () => { scroll.dispatchEvent(new dom.window.Event("scroll")); await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(host.textContent).toBe("2 replies above3 replies below");
    await render("c2");
    expect(host.textContent).toBe("");
    await render("c1");
    await act(() => useInboxStore.getState().clearReviewComments("c1"));
    expect(host.textContent).toBe("");
  } finally { await act(() => root.unmount()); scroll.remove(); host.remove(); }
});
