// /priorities' header in Modern: the glyph sits over the rank column and the
// title on the list's text edge whether or not the person arrived from
// another page; the way back ("← Inbox") goes with the actions on the right.
// Run: cd packages/web && bun test --isolate components/priorities/PrioritiesHeader.mount.test.tsx
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/priorities" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Where the back control would go: the trail's last step, or nowhere.
let target: { label: string; path: string; fromTrail: boolean; go: () => void } | null = null;
const realTrail = { ...(await import("../../hooks/useNavTrail")) };
mock.module("../../hooks/useNavTrail", () => ({ ...realTrail, useBackTarget: () => target }));

const { createRoot } = await import("react-dom/client");
const { ThemeContext } = await import("../ThemeProvider");
const { PrioritiesHeader } = await import("./PrioritiesHeader");

const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

async function mount(layout: "wide" | "phone" = "wide") {
  root = createRoot(host);
  await act(() => root!.render(
    <ThemeContext.Provider value={{ theme: "dark", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} }}>
      <MemoryRouter initialEntries={["/priorities"]}><PrioritiesHeader legacy={null} count={4} layout={layout} /></MemoryRouter>
    </ThemeContext.Provider>,
  ));
}

/** The header row's place group: what comes before the title, in order. */
function lead() {
  const place = host.querySelector("[data-cc-page-head] > div > div")!;
  const items = [...place.children];
  return { items, glyphAt: items.findIndex((el) => el.querySelector("[data-priorities-glyph]")), titleAt: items.findIndex((el) => el.tagName === "H1" || !!el.querySelector("h1")) };
}

for (const arrived of [false, true]) {
  test(`${arrived ? "arriving from the inbox" : "opened cold"}: the glyph leads the row, then the title, with nothing before them`, async () => {
    target = arrived ? { label: "Inbox", path: "/inbox", fromTrail: true, go: () => {} } : null;
    await mount();
    const { glyphAt, titleAt } = lead();
    expect(glyphAt).toBe(0);
    expect(titleAt).toBe(1);
    expect(host.querySelector("[data-priorities-glyph]")!.className).toContain("w-5");
    const back = host.querySelector("[data-cc-nav-back]");
    if (!arrived) {
      expect(back).toBeNull();
      return;
    }
    // The way back is on the right, with the legend.
    expect(back?.textContent).toBe("Inbox");
    expect(back!.closest(".ml-auto")).not.toBeNull();
    expect(back!.closest(".ml-auto")!.querySelector("[data-legend-button]")).not.toBeNull();
  });
}

test("the glyph's box is as wide as the list's rank column on each layout: 20px wide, 16px on the phone", async () => {
  target = null;
  await mount("wide");
  expect(host.querySelector("[data-priorities-glyph]")!.className.split(" ")).toContain("w-5");
  await act(() => root!.unmount());
  await mount("phone");
  const phone = host.querySelector("[data-priorities-glyph]")!.className.split(" ");
  expect(phone).toContain("w-4");
  expect(phone).not.toContain("w-5");
  // The list's own columns, so the two stay one edge (components/priorities/PriorityBlock).
  const { readFileSync } = await import("node:fs");
  const block = readFileSync(new URL("./PriorityBlock.tsx", import.meta.url), "utf8");
  expect(block).toContain("grid-cols-[16px_minmax(0,1fr)_auto]");
  expect(block).toContain("grid-cols-[20px_minmax(0,1fr)_auto]");
});
