import { beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

// The walker is DOM-driven: replies are `.cc-msg-review` regions under
// `#msg-<id>` rows, chunks are the top-level blocks of their `.cc-content`.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
// jsdom has no layout; focusComposer scrolls the input into view.
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const { useInboxStore } = await import("../store/inboxStore");
const { enterReviewFromComposer, stepReviewBlock, reviewBlockCount } = await import("./reviewNav");

function mount(replies: Record<string, number>) {
  document.body.innerHTML =
    Object.entries(replies)
      .map(
        ([id, blocks]) =>
          `<div id="msg-${id}"><div class="cc-msg-review"><div class="cc-content">${"<p>x</p>".repeat(blocks)}</div></div></div>`,
      )
      .join("") + `<form><textarea data-chat-input></textarea></form>`;
}

const review = () => {
  const s = useInboxStore.getState();
  return { id: s.reviewMessageId, block: s.reviewActiveBlock };
};

beforeEach(() => {
  useInboxStore.setState({ reviewMessageId: null, reviewActiveBlock: 0, reviewEditingId: null } as any);
});

describe("enterReviewFromComposer", () => {
  test("targets the LAST mounted reply at its LAST chunk", () => {
    mount({ a: 2, b: 3 });
    expect(enterReviewFromComposer()).toBe(true);
    expect(review()).toEqual({ id: "b", block: 2 });
  });

  test("does nothing with no reply mounted", () => {
    mount({});
    expect(enterReviewFromComposer()).toBe(false);
    expect(review()).toEqual({ id: null, block: 0 });
  });

  test("an unmeasured body still counts as one chunk", () => {
    mount({ a: 0 });
    expect(reviewBlockCount(document.querySelector(".cc-msg-review")!)).toBe(1);
    enterReviewFromComposer();
    expect(review()).toEqual({ id: "a", block: 0 });
  });
});

describe("stepReviewBlock", () => {
  test("steps inside a reply, then crosses to the neighbour from the side it was approached", () => {
    mount({ a: 2, b: 3 });
    enterReviewFromComposer(); // b:2
    stepReviewBlock("b", -1);
    expect(review()).toEqual({ id: "b", block: 1 });
    stepReviewBlock("b", -1);
    expect(review()).toEqual({ id: "b", block: 0 });
    stepReviewBlock("b", -1); // up past b's first chunk → a's last
    expect(review()).toEqual({ id: "a", block: 1 });
    stepReviewBlock("a", 1); // down past a's last chunk → b's first
    expect(review()).toEqual({ id: "b", block: 0 });
  });

  test("up past the first chunk of the first reply stays put", () => {
    mount({ a: 2 });
    useInboxStore.getState().setReviewTarget("a", 0);
    expect(stepReviewBlock("a", -1)).toBe(true);
    expect(review()).toEqual({ id: "a", block: 0 });
  });

  test("down past the last chunk of the last reply leaves review and focuses the composer", () => {
    mount({ a: 1, b: 2 });
    enterReviewFromComposer(); // b:1
    stepReviewBlock("b", 1);
    expect(review()).toEqual({ id: null, block: 0 });
    expect(document.activeElement).toBe(document.querySelector("[data-chat-input]"));
  });

  test("an unmounted target is not handled", () => {
    mount({ a: 1 });
    expect(stepReviewBlock("ghost", 1)).toBe(false);
  });
});
