import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { shouldStartNavigationProgress } from "../lib/navigationProgress";

const HERE = "https://codecast.sh/inbox";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: HERE });

function click(html: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }> = {}) {
  const wrap = dom.window.document.createElement("div");
  wrap.innerHTML = html;
  const el = wrap.querySelector("a, span") ?? wrap;
  return shouldStartNavigationProgress(
    {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
      target: el,
      ...extra,
    },
    HERE,
  );
}

describe("shouldStartNavigationProgress", () => {
  test("a same-origin link to another path starts the bar", () => {
    expect(click(`<a href="/tasks/x">x</a>`)).toBe(true);
  });

  test("data-no-progress does not start the bar", () => {
    expect(click(`<a href="/tasks/x" data-no-progress="">x</a>`)).toBe(false);
  });

  test("the same path does not start the bar", () => {
    expect(click(`<a href="/inbox">here</a>`)).toBe(false);
  });

  test("a modified click does not start the bar", () => {
    expect(click(`<a href="/tasks/x">x</a>`, { metaKey: true })).toBe(false);
  });

  test("an external link does not start the bar", () => {
    expect(click(`<a href="https://github.com/x">x</a>`)).toBe(false);
  });

  test("a click that is not on a link does not start the bar", () => {
    expect(click(`<span>x</span>`)).toBe(false);
  });
});
