// The rail's view menu (InboxViewOptions) mounted in jsdom: the "Subagents on
// cards" group with its count and four modes, the "Which ones" choice under
// it (gone while Hidden is picked), no Subagents checkbox under Show, picks
// that hand back the prefs, and the dot that says something is off default.
//
// Run: bun test components/__tests__/inboxViewOptions.mount.test.tsx
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let InboxViewOptions: typeof import("../InboxViewOptions").InboxViewOptions;
let dom: { window: { close(): void } };

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const d = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  dom = d;
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "Element", "Node", "Event", "PointerEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DOMRect", "MutationObserver"]) {
    const v = (d.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  }
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!(globalThis as any).PointerEvent) (globalThis as any).PointerEvent = (globalThis as any).MouseEvent;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ InboxViewOptions } = await import("../InboxViewOptions"));
}, 60_000);

afterAll(() => {
  if (root) React.act(() => root!.unmount());
  closeDomWindow(dom);
});

let root: ReturnType<typeof createRoot> | null = null;
const picks: Array<[string, unknown]> = [];
beforeEach(() => {
  picks.length = 0;
  if (root) React.act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "<div id='root'></div>";
});

type Props = Parameters<typeof InboxViewOptions>[0];
function mount(over: Partial<Props> = {}) {
  const props: Props = {
    showTeam: false,
    teamScope: false,
    onTeamScope: () => {},
    subagentCount: 106,
    subagentRows: "folded",
    onSubagentRows: (v) => picks.push(["rows", v]),
    subagentFilter: "active",
    onSubagentFilter: (v) => picks.push(["filter", v]),
    oldCount: 1,
    showOld: false,
    onShowOld: () => {},
    showCardBars: true,
    cardBars: "hidden",
    onCardBars: () => {},
    showFavorites: false,
    favorites: false,
    onFavorites: () => {},
    ...over,
  };
  root = createRoot(document.getElementById("root")!);
  React.act(() => root!.render(React.createElement(InboxViewOptions, props)));
}

const trigger = () => document.querySelector<HTMLElement>("[data-sv-view-options]")!;
function open() {
  const t = trigger();
  React.act(() => {
    t.dispatchEvent(new (window as any).PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
  });
}
const radios = () => [...document.querySelectorAll<HTMLElement>("[role=menuitemradio]")];
const radio = (label: string) => radios().find((el) => el.textContent?.trim() === label)!;
const checkboxes = () => [...document.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")].map((el) => el.textContent?.trim());
const click = (el: Element) => React.act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })); });
const menuText = () => document.querySelector("[role=menu]")?.textContent ?? "";

test("the subagents group: its count, four modes, then Which ones with three levels; no Show checkbox", () => {
  mount();
  open();
  expect(menuText()).toContain("Subagents on cards");
  expect(menuText()).toContain("106");
  const labels = radios().map((el) => el.textContent?.trim());
  expect(labels.slice(0, 4)).toEqual(["One line", "A short row each", "A card each", "Hidden"]);
  expect(labels.slice(4, 7)).toEqual(["Working or waiting", "Also done", "All"]);
  expect(document.querySelector("[data-sv-subagent-filter-label]")?.textContent).toBe("Which ones");
  expect(radio("One line").getAttribute("aria-checked")).toBe("true");
  expect(radio("Working or waiting").getAttribute("aria-checked")).toBe("true");
  // Show holds only what it held before; subagents left it.
  expect(checkboxes()).toEqual(["Old sessions1"]);
});

test("Hidden takes Which ones away", () => {
  mount({ subagentRows: "hidden" });
  open();
  expect(radio("Hidden").getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector("[data-sv-subagent-filter-label]")).toBeNull();
  expect(radios().map((el) => el.textContent?.trim())).not.toContain("Working or waiting");
});

test("picks hand back the prefs", () => {
  mount();
  open();
  click(radio("A short row each"));
  click(radio("Also done"));
  click(radio("All"));
  click(radio("Hidden"));
  expect(picks).toEqual([["rows", "compact"], ["filter", "active_done"], ["filter", "all"], ["rows", "hidden"]]);
});

test("the dot shows when the mode or the filter is off its default", () => {
  const dot = () => trigger().querySelector("span[aria-hidden]");
  mount();
  expect(dot()).toBeNull();
  React.act(() => root!.unmount());
  mount({ subagentRows: "compact" });
  expect(dot()).not.toBeNull();
  React.act(() => root!.unmount());
  mount({ subagentFilter: "all" });
  expect(dot()).not.toBeNull();
});

test("no subagents, no group", () => {
  mount({ subagentCount: 0 });
  open();
  expect(menuText()).not.toContain("Subagents on cards");
  expect(document.querySelector("[data-sv-subagent-filter-label]")).toBeNull();
});
