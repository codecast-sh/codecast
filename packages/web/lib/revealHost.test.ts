// The inline reveal's placement and single-open rules (lib/revealHost), in
// jsdom: a band's slot lands right under the block that holds the reference
// (the paragraph for a pill, the row for a card), one reveal is open page
// wide, a recycled row re-places the slot, and quote units skip the slot so
// comment anchors keep their indices.
// Run: bun test lib/revealHost.test.ts
import { test, expect, beforeAll } from "bun:test";

let host: typeof import("./revealHost");
let quote: typeof import("./quoteUnits");

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "Element", "Node", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  host = await import("./revealHost");
  quote = await import("./quoteUnits");
}, 120_000);

function body(html: string): HTMLElement {
  document.body.innerHTML = `<div class="cc-content">${html}</div>`;
  return document.querySelector<HTMLElement>(".cc-content")!;
}
const target = (href: string) => ({ href, title: `Task: ${href}` });

test("a pill's band opens under its paragraph, not at the end of the body", () => {
  const content = body(`<p>one</p><p>see <a class="entity-ref" href="/tasks/a">a</a> here</p><p>three</p>`);
  const pill = content.querySelector<HTMLElement>("a")!;
  host.toggleReveal("m1", target("/tasks/a"), pill);
  const kids = Array.from(content.children).map((c) => c.tagName + (c.hasAttribute("data-reveal-slot") ? "[slot]" : ""));
  expect(kids).toEqual(["P", "P", "DIV[slot]", "P"]);
  host.closeReveal();
  expect(content.querySelector("[data-reveal-slot]")).toBeNull();
});

test("a card's band opens under the card row", () => {
  const content = body(`<p>intro</p><div class="entity-card-row"><div class="entity-card"><button>reveal</button></div></div><p>after</p>`);
  const button = content.querySelector<HTMLElement>("button")!;
  host.toggleReveal("m1", target("/tasks/b"), button);
  const slot = content.querySelector("[data-reveal-slot]")!;
  expect(slot.previousElementSibling?.className).toBe("entity-card-row");
  expect(slot.nextElementSibling?.textContent).toBe("after");
  host.closeReveal();
});

test("one reveal at a time: opening a second closes the first and remembers where the click landed", () => {
  const content = body(`<p><a href="/tasks/a">a</a></p><p><a href="/tasks/b">b</a></p>`);
  const [a, b] = Array.from(content.querySelectorAll<HTMLElement>("a"));
  host.toggleReveal("m1", target("/tasks/a"), a);
  const first = content.querySelector("[data-reveal-slot]")!;
  host.toggleReveal("m2", target("/tasks/b"), b);
  expect(first.isConnected).toBe(false);
  expect(content.querySelectorAll("[data-reveal-slot]").length).toBe(1);
  // Toggling the open one again closes it.
  host.toggleReveal("m2", target("/tasks/b"), b);
  expect(content.querySelector("[data-reveal-slot]")).toBeNull();
});

test("the open reveal is tracked with hold position only when it replaced another", () => {
  const content = body(`<p><a href="/tasks/a">a</a></p><p><a href="/tasks/b">b</a></p>`);
  const [a, b] = Array.from(content.querySelectorAll<HTMLElement>("a"));
  const seen: (import("./revealHost").OpenReveal | null)[] = [];
  const unsub = host.subscribeReveal(() => seen.push(host.currentReveal()));
  host.toggleReveal("m1", target("/tasks/a"), a);
  expect(seen.at(-1)?.holdTop).toBeNull();
  expect(seen.at(-1)?.fresh).toBe(true);
  host.toggleReveal("m2", target("/tasks/b"), b);
  expect(typeof seen.at(-1)?.holdTop).toBe("number");
  host.closeReveal();
  expect(seen.at(-1)).toBeNull();
  unsub();
});

test("a recycled row re-places the slot under the reference, as a restored (not fresh) band", () => {
  const content = body(`<p><a href="/tasks/a">a</a></p>`);
  const a = content.querySelector<HTMLElement>("a")!;
  host.toggleReveal("row", target("/tasks/a"), a);
  // The virtualizer drops the row and mounts it again with fresh DOM.
  const again = body(`<p><a href="/tasks/a">a</a></p>`);
  const a2 = again.querySelector<HTMLElement>("a")!;
  expect(host.currentReveal()?.slot.isConnected).toBe(false);
  host.reattachReveal("row", "/tasks/a", a2);
  const cur = host.currentReveal()!;
  expect(cur.slot.isConnected).toBe(true);
  expect(cur.slot.previousElementSibling).toBe(a2.parentElement);
  expect(cur.fresh).toBe(false);
  // A different host or href does nothing.
  host.reattachReveal("other", "/tasks/a", a2);
  expect(host.currentReveal()).toBe(cur);
  host.closeReveal();
});

test("quote units skip the slot so anchors after it keep their index", () => {
  const content = body(`<p>one</p><p><a href="/tasks/a">a</a></p><p>three</p>`);
  const a = content.querySelector<HTMLElement>("a")!;
  const before = quote.getQuoteUnits(content).map((u) => u.textContent);
  host.toggleReveal("m1", target("/tasks/a"), a);
  const during = quote.getQuoteUnits(content).map((u) => u.textContent);
  expect(during).toEqual(before);
  host.closeReveal();
});
