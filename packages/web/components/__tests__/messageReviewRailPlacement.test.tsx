// The quote rail chooses between floating in the page margin and shrinking the
// text inline by measuring the gap between the SCROLLER and the conversation
// column. The column is max-width capped and centred, so once it reaches that
// cap a splitter drag or a panel collapse widens the scroller WITHOUT resizing
// the column — and neither gesture fires a window resize. Watching only the
// column left the rail wedged inline on a screen that had since grown wide
// enough for the margin, and nothing short of an actual window resize freed it.

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore } from "../../store/inboxStore";
import { MessageReview } from "../MessageReview";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/conversation/c1",
  pretendToBeVisual: true,
});

// One fake ResizeObserver for the whole test: it records what got observed and
// lets the test deliver a resize by hand (JSDOM has no layout, so nothing else
// can).
type Entry = { target: Element; contentRect: { width: number } };
const observers: { targets: Element[]; fire: (entries: Entry[]) => void }[] = [];
class FakeResizeObserver {
  targets: Element[] = [];
  constructor(private cb: (entries: Entry[]) => void) {
    observers.push({ targets: this.targets, fire: (entries) => this.cb(entries) });
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {}
}

// JSDOM reports every rect as zero. Model the one thing the placement depends
// on: a scroller of some width, and a column pinned at its max width, centred.
let scrollerWidth = 960;
const COLUMN_W = 848; // the column's cap — it never changes in this test
let scrollerEl: HTMLElement | null = null;
(dom.window.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
  function (this: HTMLElement) {
    const left = this === scrollerEl ? 0 : Math.round((scrollerWidth - COLUMN_W) / 2);
    const width = this === scrollerEl ? scrollerWidth : COLUMN_W;
    return { left, right: left + width, top: 0, bottom: 0, width, height: 0, x: left, y: 0, toJSON() {} } as DOMRect;
  };

const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  HTMLElement: dom.window.HTMLElement,
  ResizeObserver: FakeResizeObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});

test("widening the scroller un-wedges the rail even when the column never resizes", async () => {
  useInboxStore.setState({
    reviewComments: {
      c1: [{ id: "q1", messageId: "m1", blockIndex: 0, quote: "a quoted line", body: "", createdAt: 1 }],
    },
  });

  // The scroll container the column lives in — found by walking up for the
  // first ancestor that is not overflow:visible.
  scrollerEl = document.createElement("div");
  scrollerEl.style.overflowY = "auto";
  const column = document.createElement("div");
  scrollerEl.appendChild(column);
  document.body.appendChild(scrollerEl);

  const root = createRoot(column);
  try {
    await act(() =>
      root.render(
        <MessageReview conversationId="c1" messageId="m1" content="a quoted line" renderBlock={(c) => <p>{c}</p>} />,
      ),
    );
    const region = column.querySelector(".cc-msg-review") as HTMLElement;

    // 960px of scroller leaves 56px of margin — too tight for a rail, so the
    // rail shrinks the text inline.
    expect(region.className).toContain("cc-rail-inline");

    // The scroller is observed: the column alone cannot report this change.
    const ro = observers.find((o) => o.targets.includes(scrollerEl!));
    expect(ro).toBeDefined();

    // A splitter drag: the scroller grows, the column stays at its cap, no
    // window resize fires. Only the scroller's own entry reports it.
    scrollerWidth = 1400;
    await act(async () => {
      ro!.fire([{ target: scrollerEl!, contentRect: { width: 1400 } }]);
    });
    expect(region.className).toContain("cc-rail-margin");

    // ...and dragging it back the other way returns the rail inline.
    scrollerWidth = 960;
    await act(async () => {
      ro!.fire([{ target: scrollerEl!, contentRect: { width: 960 } }]);
    });
    expect(region.className).toContain("cc-rail-inline");

    // A height-only change on the scroller (the composer growing) is not a
    // reason to re-measure every engaged message.
    let measured = 0;
    const rect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    (dom.window.HTMLElement.prototype as unknown as { getBoundingClientRect: unknown }).getBoundingClientRect =
      function (this: HTMLElement) {
        if (this === scrollerEl) measured++;
        return rect.call(this);
      };
    await act(async () => {
      ro!.fire([{ target: scrollerEl!, contentRect: { width: 960 } }]);
    });
    (dom.window.HTMLElement.prototype as unknown as { getBoundingClientRect: unknown }).getBoundingClientRect = rect;
    expect(measured).toBe(0);
  } finally {
    await act(() => root.unmount());
    useInboxStore.setState({ reviewComments: {} });
  }
});
