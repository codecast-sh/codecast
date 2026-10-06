import assert from "node:assert/strict";
import { test } from "bun:test";
import { replaceGlobals } from "../test-helpers/globals";

// A closed quote's box must not depend on whether it measured as long. A user
// message holding many quotes used to paint them unfolded and fold them a
// frame later; under the conversation virtualizer each such mount resized the
// row above the viewport and jumped the feed back and forth while scrolling up.
test("a closed quote is capped the same whether or not it measured as long; opening lifts the cap", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/" });
  const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no layout: report the height each quote's text implies.
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.textContent!.startsWith("long") ? 120 : 20; },
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ReplyQuote } = await import("./ReplyQuote");
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(async () => root.render(
      <>
        <ReplyQuote><div>long quote, four lines of it</div></ReplyQuote>
        <ReplyQuote><div>short</div></ReplyQuote>
      </>,
    ));
    const [long, short] = [...document.querySelectorAll<HTMLElement>(".cc-quote")];
    const bodyOf = (q: HTMLElement) => q.querySelector<HTMLElement>(".cc-quote-body")!;
    assert.ok(long.classList.contains("cc-quote-folded"), "the long quote folds");
    assert.ok(!short.classList.contains("cc-quote-folds"), "the short quote does not");
    assert.equal(bodyOf(long).getAttribute("style"), bodyOf(short).getAttribute("style"), "same cap either way");
    assert.equal(bodyOf(long).style.maxHeight, "48px");
    assert.equal(bodyOf(long).style.overflow, "hidden");

    await React.act(async () => long.click());
    assert.ok(!long.classList.contains("cc-quote-folded"));
    assert.equal(bodyOf(long).style.maxHeight, "", "an open quote shows everything");
  } finally {
    await React.act(async () => root.unmount());
    restore();
  }
}, 120_000);
