import { describe, expect, test } from "bun:test";
import { clip, selectorFor, type SelectorNode } from "./picker";

/** A tiny element tree: tag(id?) with children. */
function el(tagName: string, id = "", children: SelectorNode[] = []): SelectorNode {
  const node: SelectorNode = { tagName: tagName.toUpperCase(), id, parentElement: null, children };
  for (const c of children) c.parentElement = node;
  return node;
}

describe("selectorFor", () => {
  const first = el("li");
  const second = el("li");
  const button = el("button");
  const list = el("ul", "", [first, second]);
  const main = el("main", "", [el("h1"), list, button]);
  el("html", "", [el("head"), el("body", "", [el("div", "root", [main])])]);

  test("starts at the nearest id", () => {
    expect(selectorFor(button)).toBe("#root > main > button");
  });

  test("numbers only the steps whose siblings share the tag", () => {
    expect(selectorFor(second)).toBe("#root > main > ul > li:nth-of-type(2)");
    expect(selectorFor(first)).toBe("#root > main > ul > li:nth-of-type(1)");
  });

  test("ids that are not simple identifiers are skipped", () => {
    const leaf = el("span");
    el("html", "", [el("body", "", [el("div", "1:weird", [leaf])])]);
    expect(selectorFor(leaf)).toBe("html > body > div > span");
  });
});

test("clip marks a cut and leaves short text alone", () => {
  expect(clip("abcdef", 4)).toBe("abc…");
  expect(clip("abc", 4)).toBe("abc");
});
