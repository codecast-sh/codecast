// A quote card follows its block when the text under it changes (a doc edited,
// a plan rewritten): it says "moved" when its block went elsewhere and
// "outdated" when the block is gone. Only the drawing changes; the batch item,
// and so what the composer sends, stays exactly as quoted.

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { useInboxStore } from "../../store/inboxStore";
import { MessageReview } from "../MessageReview";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/docs/d1",
  pretendToBeVisual: true,
});

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  HTMLElement: dom.window.HTMLElement,
  ResizeObserver: NoopResizeObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const paragraphs = (content: string) => <>{content.split("\n\n").map((p, i) => <p key={i}>{p}</p>)}</>;

test("a quote card reads moved, then outdated, as its block moves and goes", async () => {
  const item = { id: "q1", messageId: "doc:d1", blockIndex: 1, quote: "Old writes stop after the sweep is clean.", body: "why wait?", createdAt: 1 };
  useInboxStore.setState({ reviewComments: { "doc:d1": [item] } });

  const host = document.createElement("div");
  host.style.overflowY = "auto";
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (content: string) =>
    act(() => root.render(<MessageReview conversationId="doc:d1" messageId="doc:d1" content={content} renderBlock={paragraphs} />));
  const state = () => host.querySelector("[data-review-comment='q1'] [data-anchor-state]")?.getAttribute("data-anchor-state") ?? null;

  try {
    await render("# Plan\n\nOld writes stop after the sweep is clean.\n\nThen we retire the table.");
    expect(state()).toBeNull();

    await render("# Plan\n\nA new caveat paragraph.\n\nOld writes stop after the sweep is clean.\n\nThen we retire the table.");
    expect(state()).toBe("moved");

    await render("# Plan\n\nA new caveat paragraph.\n\nThen we retire the table.");
    expect(state()).toBe("outdated");

    expect(useInboxStore.getState().reviewComments["doc:d1"]).toEqual([item]);
  } finally {
    await act(() => root.unmount());
    useInboxStore.setState({ reviewComments: {} });
  }
});
