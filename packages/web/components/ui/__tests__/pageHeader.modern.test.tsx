// The shared page header shows only in the Modern style. Classic and Minimal
// draw each page's own header (`legacy`) and nothing else, so they look as
// they did before; Modern draws one bar: the page's name as the h1, its count,
// crumbs, tabs, actions and the share control last. PageFrame pins that bar
// above the page's scroller in Modern and keeps the page's own frame elsewhere.
// Run: cd packages/web && bun test --isolate components/ui/__tests__/pageHeader.modern.test.tsx
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import type { VisualStyle } from "../../ThemeProvider";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/tasks" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperties(dom.window.HTMLElement.prototype, {
  offsetHeight: { get() { return this.hasAttribute("data-index") ? 40 : 600; } },
  offsetWidth: { get: () => 1000 },
});
dom.window.HTMLElement.prototype.scrollTo = () => {};

const { createRoot } = await import("react-dom/client");
const { ThemeContext } = await import("../../ThemeProvider");
const { PageFrame, PageHeader } = await import("../page-header");
const { GenericListView } = await import("../../GenericListView");
const { ownsCanvasInModern } = await import("../../../lib/pageLayout");

const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

async function mount(style: VisualStyle, node: ReactNode) {
  root = createRoot(host);
  await act(() => root!.render(
    <ThemeContext.Provider value={{ theme: "dark", toggleTheme: () => {}, visualStyle: style, setVisualStyle: () => {} }}>
      <MemoryRouter initialEntries={["/tasks"]}>{node}</MemoryRouter>
    </ThemeContext.Provider>,
  ));
}

const legacy = <div data-legacy-head><h1>Old title</h1></div>;
const header = (
  <PageHeader
    legacy={legacy}
    title="Triggers"
    count={7}
    crumbs={<a href="/home">Home</a>}
    tabs={<button type="button">Tab</button>}
    actions={<button type="button">Act</button>}
    share={<button type="button" data-share>Share</button>}
  />
);

describe("PageHeader", () => {
  for (const style of ["classic", "minimal"] as const) {
    test(`${style} draws the page's own header and nothing else`, async () => {
      await mount(style, header);
      expect(host.querySelector("[data-legacy-head]")).not.toBeNull();
      expect(host.querySelector("[data-cc-page-head]")).toBeNull();
      expect(host.querySelector("h1")?.textContent).toBe("Old title");
    });
  }

  test("modern draws the one bar: the name as the h1, the count, crumbs, and share last", async () => {
    await mount("modern", header);
    expect(host.querySelector("[data-legacy-head]")).toBeNull();
    const bar = host.querySelector("header[data-cc-page-head]")!;
    expect(bar).not.toBeNull();
    const h1 = bar.querySelector("h1")!;
    expect(h1.textContent).toBe("Triggers");
    expect(h1.getAttribute("title")).toBe("Triggers");
    expect(h1.className).toContain("text-read");
    expect(bar.querySelector("[data-cc-page-count]")?.textContent).toBe("7");
    expect(bar.querySelector("a[href='/home']")).not.toBeNull();
    const buttons = [...bar.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Tab", "Act", "Share"]);
  });
});

describe("PageFrame", () => {
  const frame = (
    <PageFrame header={header} legacyScroll="legacy-scroll" legacyScrollProps={{ "data-main-scroll": true }} legacyColumn="legacy-column" column="modern-column">
      <p data-body>Body</p>
    </PageFrame>
  );

  test("classic keeps the page's frame: its scroller, its column, the header at the column's top", async () => {
    await mount("classic", frame);
    const scroll = host.querySelector(".legacy-scroll")!;
    expect(scroll.hasAttribute("data-main-scroll")).toBe(true);
    const column = scroll.querySelector(":scope > .legacy-column")!;
    expect(column.firstElementChild?.hasAttribute("data-legacy-head")).toBe(true);
    expect(column.querySelector("[data-body]")).not.toBeNull();
    expect(host.querySelector(".modern-column")).toBeNull();
  });

  test("modern pins the bar above a scroller that holds the column", async () => {
    await mount("modern", frame);
    const bar = host.querySelector("[data-cc-page-head]")!;
    const scroller = bar.nextElementSibling!;
    expect(scroller.hasAttribute("data-main-scroll")).toBe(true);
    expect(scroller.querySelector(".modern-column [data-body]")).not.toBeNull();
    expect(host.querySelector(".legacy-scroll")).toBeNull();
  });
});

test("only the listed shell pages own their canvas in Modern, by exact path", () => {
  for (const p of ["/notifications", "/pages", "/artifacts", "/feed", "/expectations", "/week", "/mods", "/pages?x=1"]) {
    expect(ownsCanvasInModern(p)).toBe(true);
  }
  for (const p of ["/team", "/pages/auth", "/feedback", "/search"]) expect(ownsCanvasInModern(p)).toBe(false);
});

describe("a list page (Tasks, Docs, Decisions: GenericListView)", () => {
  const list = (page?: boolean) => (
    <GenericListView<{ id: string }>
      title="Tasks"
      page={page}
      tabs={[{ key: "open", label: "Open", count: 2 }, { key: "all", label: "All", count: 3 }]}
      activeTab="open"
      onTabChange={() => {}}
      groups={null}
      flatItems={[{ id: "a" }]}
      renderRow={(item) => <span>{item.id}</span>}
      getItemId={(item) => item.id}
      getItemRoute={(item) => `/tasks/${item.id}`}
      sortOptions={[{ value: "updated", label: "Updated" }]}
      sortBy="updated"
      onSortChange={() => {}}
    />
  );

  test("classic keeps the list's own bar, the name for screen readers only", async () => {
    await mount("classic", list());
    expect(host.querySelector("[data-cc-page-head]")).toBeNull();
    expect(host.querySelector("h1.sr-only")?.textContent).toBe("Tasks");
    expect(host.querySelector(".cc-panel__head--flow [data-list-tabs]")).not.toBeNull();
  });

  test("modern names the page in the shared header, with the tabs and the toolbar in it", async () => {
    await mount("modern", list());
    const bar = host.querySelector("[data-cc-page-head]")!;
    expect(bar.querySelector("h1")?.textContent).toBe("Tasks");
    expect(host.querySelector("h1.sr-only")).toBeNull();
    expect(bar.querySelector("[data-list-tabs]")).not.toBeNull();
    expect(bar.querySelector("[data-list-toolbar]")).not.toBeNull();
  });

  test("modern keeps the pane bar when the list is one pane of another page", async () => {
    await mount("modern", list(false));
    expect(host.querySelector("[data-cc-page-head]")).toBeNull();
    expect(host.querySelector("h1.sr-only")?.textContent).toBe("Tasks");
  });
});
