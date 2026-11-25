import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { escapeStep, keepsOwnEnter, layerOpen } from "../useChangesKeys";
import { EMPTY_URL, hasFilters, toggleArea, type ChangesUrl } from "../useChangesUrlState";
import { DAY, edition, story } from "./fixtures";
import { pageSource } from "./pageSources";

// The page's keys share the keyboard with the controls inside it
// (changes-page.md 6.1). Three rules keep them apart: Enter on a link or a
// button inside a story is that control's own, every page key stands down
// while a menu is open, and Escape in the filter field works on the field
// before it touches the page.

const doc = (body: string) => new JSDOM(`<body>${body}</body>`).window.document;

describe("Enter inside a story", () => {
  const page = doc(`
    <article data-story-key="s1" data-story-trigger tabindex="0" id="trigger">
      <h3 id="headline">Headline</h3>
      <a href="/commit/acme/app/abc1234" id="commit">+12 -3 1 commit</a>
      <a class="entity-ref" href="/conversation/jx7" id="pill"><span id="pill-text">jx7c6zk</span></a>
      <button id="more">Copy link</button>
      <p id="prose">A paragraph</p>
    </article>
    <input id="filter" />
    <div role="menuitem" id="item">main</div>
  `);
  const at = (id: string) => page.getElementById(id);

  test("a link, a pill or a button inside a change keeps its own Enter", () => {
    for (const id of ["commit", "pill", "pill-text", "more"]) expect({ id, own: keepsOwnEnter(at(id)) }).toEqual({ id, own: true });
  });

  test("on the change itself, Enter is the page's: it opens or closes the change", () => {
    for (const id of ["trigger", "headline"]) expect({ id, own: keepsOwnEnter(at(id)) }).toEqual({ id, own: false });
  });

  test("controls outside the stories keep theirs; plain content and no focus do not", () => {
    expect(keepsOwnEnter(at("filter"))).toBe(true);
    expect(keepsOwnEnter(at("item"))).toBe(true);
    expect(keepsOwnEnter(at("prose"))).toBe(false);
    expect(keepsOwnEnter(page.body)).toBe(false);
    expect(keepsOwnEnter(null)).toBe(false);
  });

  test("the page's Enter asks this rule before it opens or closes a change", () => {
    const page = pageSource("ChangesPage.tsx");
    const evidence = page.slice(page.indexOf("evidence: () => {"), page.indexOf("open: () =>"));
    expect(evidence).toMatch(/if \(keepsOwnEnter\(document\.activeElement\)\) return false;/);
    expect(evidence.indexOf("keepsOwnEnter")).toBeLessThan(evidence.indexOf("toggle("));
  });
});

describe("an open menu owns the keyboard", () => {
  test("a handler declines while a menu or a listbox is open, and answers once it closes", () => {
    expect(layerOpen(doc(`<div role="menu" data-state="open"></div>`))).toBe(true);
    expect(layerOpen(doc(`<div role="listbox" data-state="open"></div>`))).toBe(true);
    expect(layerOpen(doc(`<div role="menu" data-state="closed"></div><div role="tablist" data-state="open"></div>`))).toBe(false);
    expect(layerOpen(doc(``))).toBe(false);
  });

  test("every Changes action goes through the one gate", () => {
    const keys = pageSource("useChangesKeys.tsx");
    expect(keys).toMatch(/const here = [^\n]*active && !layerOpen\(\) \? fn\(\) : false/);
    const bound = [...keys.matchAll(/useShortcutAction\("changes\.\w+", ([^)]*\)?)\);/g)].map((m) => m[1]);
    expect(bound.length).toBeGreaterThanOrEqual(9);
    for (const handler of bound) expect(handler).toMatch(/^here\(h\.\w+\)$/);
  });
});

describe("Escape", () => {
  const base = { inFilterField: false, q: undefined, story: undefined, filtered: false, filterOpen: false };

  test("in the filter field with chips set, it clears only the text; then it leaves the field", () => {
    // `filtered` is true for the chips and the text alike, and an open drawer waits too.
    expect(escapeStep({ ...base, inFilterField: true, q: "sync", filtered: true, story: "s1", filterOpen: true })).toBe("clear-text");
    expect(escapeStep({ ...base, inFilterField: true, filtered: true, story: "s1", filterOpen: true })).toBe("leave-field");
  });

  test("elsewhere it closes the open change, then clears filters, then closes the filter bar", () => {
    expect(escapeStep({ ...base, story: "s1", filtered: true, filterOpen: true, q: "sync" })).toBe("close-story");
    expect(escapeStep({ ...base, filtered: true, filterOpen: true, q: "sync" })).toBe("clear-filters");
    expect(escapeStep({ ...base, filterOpen: true })).toBe("close-filter");
    expect(escapeStep(base)).toBeNull();
  });

  test("clearing the text writes only q", () => {
    const page = pageSource("ChangesPage.tsx");
    expect(page).toContain('if (step === "clear-text") setUrl({ q: undefined });');
  });
});

