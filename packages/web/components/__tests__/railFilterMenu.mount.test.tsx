import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { FolderActivity } from "../../lib/railFolderFilter";
// Imported before the DOM globals exist, so the store skips its browser-only
// cache hydration (IndexedDB), which JSDOM can't serve.
import { useInboxStore } from "../../store/inboxStore";
import { LabelChipsRow } from "../LabelChipsRow";

// The session rail's filter is one button and one menu (components/LabelChipsRow).
// What matters: the idle header shows no chip row, the menu's folder list is a
// short one (five, no scratch folders) with the rest behind "All folders…",
// and an active filter is named on the button with a way to clear it.

// A real URL: setting a filter writes it to the address bar (pushState).
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/inbox" });
const w = dom.window as any;
const restoreGlobals = replaceGlobals({
  window: w,
  document: w.document,
  navigator: w.navigator,
  HTMLElement: w.HTMLElement,
  HTMLButtonElement: w.HTMLButtonElement,
  HTMLInputElement: w.HTMLInputElement,
  Element: w.Element,
  Node: w.Node,
  Event: w.Event,
  CustomEvent: w.CustomEvent,
  MouseEvent: w.MouseEvent,
  PointerEvent: w.PointerEvent ?? w.MouseEvent,
  KeyboardEvent: w.KeyboardEvent,
  FocusEvent: w.FocusEvent,
  MutationObserver: w.MutationObserver,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  DOMRect: w.DOMRect,
  requestAnimationFrame: w.requestAnimationFrame,
  cancelAnimationFrame: w.cancelAnimationFrame,
  getComputedStyle: w.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const A = "mh73xedd7ep2nmr082mqnxts2x86kzfy";
const B = "jx75sqw53801qvexsvem39mbhh88c8wt";

const projectCounts: Array<[string, number]> = [
  ["a8c23c5c-46dd-4f1e-9a2b-3c4d5e6f7a8b", 50],
  ["littlebird", 40],
  ["alexandergreen", 15],
  ["codecast", 12],
  ["infra", 9],
  ["docs-site", 6],
  ["website", 4],
  ["and-just-in-general-this-is", 1],
];
const now = Date.now();
const projectActivity: Record<string, FolderActivity> = Object.fromEntries(
  projectCounts.map(([name, count]) => [name, { recent: count, lastActive: now }]),
);
const projectPathByName = Object.fromEntries(projectCounts.map(([name]) => [name, `/code/${name}`]));

beforeEach(() => {
  useInboxStore.setState({
    buckets: {
      [A]: { _id: A, name: "growth", sort_order: 0 },
      [B]: { _id: B, name: "outreach", sort_order: 1 },
    } as any,
    activeBucketFilter: null,
    activeProjectFilter: null,
    chipFilterExclude: false,
    extraBucketFilters: [],
    extraProjectFilters: [],
    activeProjectPath: null,
  } as any);
});

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <LabelChipsRow
        bucketCounts={{ [A]: 3 }}
        projectCounts={projectCounts}
        projectPathByName={projectPathByName}
        projectActivity={projectActivity}
        dropSessionOnLabel={() => {}}
      />,
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const button = () => container.querySelector<HTMLButtonElement>("[data-sv-filter-button]")!;
  const open = () =>
    act(async () => {
      button().dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  const folders = () => [...document.querySelectorAll<HTMLElement>("[data-filter-folder]")].map((el) => el.dataset.filterFolder);
  return { container, button, open, folders };
}

test("the idle header is one Filter button, no chip row", async () => {
  const m = await mount();
  expect(m.button().textContent).toBe("Filter");
  expect(m.button().hasAttribute("data-active")).toBe(false);
  expect(m.container.querySelectorAll("button").length).toBe(1);
  expect(m.container.textContent).not.toContain("littlebird");
  expect(m.container.querySelector("[data-sv-rail-filter-clear]")).toBeNull();
});

test("the short list caps at five and leaves out UUID and one-off prompt folders", async () => {
  const m = await mount();
  await m.open();
  expect(m.folders()).toEqual(["littlebird", "alexandergreen", "codecast", "infra", "docs-site"]);
  // Labels share the menu, with New label… kept.
  expect(document.querySelector(`[data-filter-label="${A}"]`)).toBeTruthy();
  expect(document.querySelector("[data-filter-new-label]")).toBeTruthy();
});

test("All folders… shows every folder, scratch ones included, and searches them", async () => {
  const m = await mount();
  await m.open();
  const all = document.querySelector<HTMLElement>("[data-filter-all-folders]")!;
  expect(all.textContent).toContain(String(projectCounts.length));
  await act(async () => all.click());
  expect(m.folders()).toEqual(projectCounts.map(([name]) => name));
  const search = document.querySelector<HTMLInputElement>("[data-filter-folder-search]")!;
  expect(search).toBeTruthy();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!;
    setValue.call(search, "site");
    search.dispatchEvent(new w.Event("input", { bubbles: true }));
  });
  expect(m.folders()).toEqual(["docs-site", "website"]);
});

test("picking a folder filters to it, and the button names it with a clear ×", async () => {
  const m = await mount();
  await m.open();
  const item = document.querySelector<HTMLElement>('[data-filter-folder="codecast"]')!;
  await act(async () => item.click());
  const st = useInboxStore.getState();
  expect(st.activeProjectFilter).toBe("codecast");
  expect(st.activeProjectPath).toBe("/code/codecast");
  expect(m.button().textContent).toBe("codecast");
  expect(m.button().getAttribute("data-active")).toBe("true");
  const clear = m.container.querySelector<HTMLButtonElement>("[data-sv-rail-filter-clear]")!;
  expect(clear).toBeTruthy();
  await act(async () => clear.click());
  expect(useInboxStore.getState().activeProjectFilter).toBeNull();
  expect(m.button().textContent).toBe("Filter");
});

test("an exclusion and a multi-term label filter read on the button", async () => {
  useInboxStore.setState({ activeProjectFilter: "littlebird", activeProjectPath: "/code/littlebird", chipFilterExclude: true } as any);
  const m = await mount();
  expect(m.button().textContent).toBe("Not littlebird");
  await act(async () => {
    useInboxStore.setState({
      activeProjectFilter: null,
      activeProjectPath: null,
      chipFilterExclude: false,
      activeBucketFilter: A,
      extraBucketFilters: [{ id: B, exclude: false }],
    } as any);
  });
  expect(m.button().textContent).toBe("growth+1");
  expect(m.button().getAttribute("aria-label")).toBe("Filter: growth and 1 more");
});

test("an active folder outside the top five still shows in the short list, marked", async () => {
  useInboxStore.setState({ activeProjectFilter: "website", activeProjectPath: "/code/website" } as any);
  const m = await mount();
  await m.open();
  expect(m.folders()).toContain("website");
  expect(document.querySelector<HTMLElement>('[data-filter-folder="website"]')!.dataset.term).toBe("include");
});

test("⇧-click adds a term and keeps the menu open; ⌥+Enter on the keyboard hides", async () => {
  const m = await mount();
  await m.open();
  await act(async () => {
    document.querySelector<HTMLElement>('[data-filter-folder="codecast"]')!.click();
  });
  await m.open();
  await act(async () => {
    document
      .querySelector<HTMLElement>('[data-filter-folder="infra"]')!
      .dispatchEvent(new w.MouseEvent("click", { bubbles: true, shiftKey: true }));
  });
  expect(document.querySelector('[data-filter-folder="infra"]')).toBeTruthy(); // still open
  const st = useInboxStore.getState();
  expect(st.activeProjectFilter).toBe("codecast");
  expect(st.extraProjectFilters.map((t: { id: string }) => t.id)).toEqual(["infra"]);
  expect(m.button().textContent).toBe("codecast+1");

  // A plain keyboard pick with ⌥ held: "everything but this folder".
  await act(async () => {
    document
      .querySelector<HTMLElement>('[data-filter-folder="littlebird"]')!
      .dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true }));
  });
  expect(useInboxStore.getState().activeProjectFilter).toBe("littlebird");
  expect(useInboxStore.getState().chipFilterExclude).toBe(true);
  expect(m.button().textContent).toBe("Not littlebird");
});
