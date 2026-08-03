// Widget hydration is codecast-owned behavior attached to sanitized markup —
// these tests pin the markup contract (tabs from <section data-tab>, sortable
// .cast-table) and the numeric-aware sort.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";

const g = globalThis as Record<string, unknown>;
const hadWindow = "window" in g;
let dom: JSDOM;

beforeAll(() => {
  dom = new JSDOM("<body></body>");
  g.window = dom.window;
});

afterAll(() => {
  if (!hadWindow) delete g.window;
});

async function hydrate(html: string) {
  const { hydrateWidgets } = await import("../castWidgets");
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;
  hydrateWidgets(host);
  return host;
}

describe("cast-tabs", () => {
  const TABS =
    '<div class="cast-tabs">' +
    '<section data-tab="One"><p>first</p></section>' +
    '<section data-tab="Two"><p>second</p></section>' +
    '<section data-tab="Three"><p>third</p></section>' +
    "</div>";

  test("builds a tab bar and shows only the first panel", async () => {
    const host = await hydrate(TABS);
    const buttons = host.querySelectorAll(".cast-tabs-bar button");
    expect(buttons.length).toBe(3);
    expect(buttons[0]?.textContent).toBe("One");
    const panels = host.querySelectorAll("section[data-tab]");
    expect((panels[0] as HTMLElement).hidden).toBe(false);
    expect((panels[1] as HTMLElement).hidden).toBe(true);
  });

  test("clicking a tab switches the visible panel", async () => {
    const host = await hydrate(TABS);
    const buttons = host.querySelectorAll<HTMLButtonElement>(".cast-tabs-bar button");
    buttons[1]?.click();
    const panels = host.querySelectorAll("section[data-tab]");
    expect((panels[0] as HTMLElement).hidden).toBe(true);
    expect((panels[1] as HTMLElement).hidden).toBe(false);
    expect(buttons[1]?.getAttribute("aria-selected")).toBe("true");
  });

  test("data-active picks the initial panel", async () => {
    const host = await hydrate(
      '<div class="cast-tabs"><section data-tab="A">a</section><section data-tab="B" data-active>b</section></div>',
    );
    const panels = host.querySelectorAll("section[data-tab]");
    expect((panels[0] as HTMLElement).hidden).toBe(true);
    expect((panels[1] as HTMLElement).hidden).toBe(false);
  });

  test("hydration is idempotent", async () => {
    const { hydrateWidgets } = await import("../castWidgets");
    const host = await hydrate(TABS);
    hydrateWidgets(host);
    expect(host.querySelectorAll(".cast-tabs-bar").length).toBe(1);
  });

  test("a single panel gets no tab bar", async () => {
    const host = await hydrate('<div class="cast-tabs"><section data-tab="Only">x</section></div>');
    expect(host.querySelector(".cast-tabs-bar")).toBeNull();
  });
});

describe("cast-table", () => {
  const TABLE =
    '<table class="cast-table"><thead><tr><th>Name</th><th>Size</th></tr></thead>' +
    "<tbody>" +
    "<tr><td>beta</td><td>1,200</td></tr>" +
    "<tr><td>alpha</td><td>90</td></tr>" +
    "<tr><td>gamma</td><td>$3.5</td></tr>" +
    "</tbody></table>";

  function col0(host: HTMLElement): string[] {
    return Array.from(host.querySelectorAll("tbody tr")).map(
      (r) => r.querySelectorAll("td")[0]?.textContent ?? "",
    );
  }

  test("clicking a header sorts rows as text, second click reverses", async () => {
    const host = await hydrate(TABLE);
    const th = host.querySelectorAll<HTMLElement>("th")[0]!;
    th.click();
    expect(col0(host)).toEqual(["alpha", "beta", "gamma"]);
    th.click();
    expect(col0(host)).toEqual(["gamma", "beta", "alpha"]);
  });

  test("numeric columns sort by value ($, commas stripped)", async () => {
    const host = await hydrate(TABLE);
    const th = host.querySelectorAll<HTMLElement>("th")[1]!;
    th.click();
    expect(col0(host)).toEqual(["gamma", "alpha", "beta"]); // 3.5 < 90 < 1200
  });
});
