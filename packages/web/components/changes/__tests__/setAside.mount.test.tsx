// ct-101824: a person sets a change aside from its row's hover card on the Deploys page's "On its way", and brings it
// back from Parked. Mounted in jsdom over the real store, so the write is the store's own action and the row moves in
// the same render, with no server in the loop.
//
// Run: bun test components/changes/__tests__/setAside.mount.test.tsx
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const realRepoChanges = { ...(await import("../../../hooks/useRepoChanges")) };
afterAll(() => { mock.module("../../../hooks/useRepoChanges", () => realRepoChanges); });

const DAY = 86_400_000;
const repo = "acme/app";
let dom: { window: { close(): void } };
let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let OnItsWay: typeof import("../OnItsWay").OnItsWay;
let MemoryRouter: typeof import("react-router").MemoryRouter;
let store: typeof import("../../../store/inboxStore").useInboxStore;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const d = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/deploys", pretendToBeVisual: true });
  dom = d;
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "FocusEvent", "PointerEvent", "HTMLDivElement", "HTMLSpanElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DOMRect"]) {
    const v = (d.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  }
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  const { assemble } = await import("../../../lib/changes/assemble");
  const { changeLifecycle } = await import("../../../lib/changes/lifecycle");
  const now = Date.now();
  const pr = (number: number, over: Record<string, unknown>) => ({
    repository: repo, number, state: "open", title: `PR ${number}`, head_ref: `x/${number}`,
    created_at: now - DAY, updated_at: now - DAY, files_synced_at: now - DAY, ...over,
  });
  const changes = assemble({ repository: repo, now, pullRequests: [pr(11, { checks_state: "failure" }), pr(12, { checks_state: "success", review_decision: "REVIEW_REQUIRED" })] as any })
    .map((c) => ({ ...c, lifecycle: changeLifecycle(c.facts) }));
  mock.module("../../../hooks/useRepoChanges", () => ({ ...realRepoChanges, useRepoChanges: () => ({ ready: true, changes }) }));
  ({ MemoryRouter } = await import("react-router"));
  ({ OnItsWay } = await import("../OnItsWay"));
  ({ useInboxStore: store } = await import("../../../store/inboxStore"));
  store.setState({ clientState: {}, clientStateInitialized: true } as any);
});

afterAll(() => { closeDomWindow(dom); });

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const inGroup = (group: string, n: number) => !![...document.querySelectorAll(`[data-change-group="${group}"] [data-change-row]`)].find((el) => el.textContent?.includes(`#${n}`));
/** Hover a row's name until its card opens, then press the card's set-aside control. */
async function pressAside(n: number, label: string) {
  const row = [...document.querySelectorAll("[data-change-row]")].find((el) => el.textContent?.includes(`#${n}`))!;
  const name = row.querySelector(".chb-name")!;
  await act(async () => { name.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  await wait(260);
  const button = q("[data-change-aside]")!;
  expect(button.textContent).toBe(label);
  await act(async () => { button.click(); });
  await act(async () => { name.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
  await wait(200);
}

test("set aside moves a row to Parked at once, says why, and Bring back returns it", async () => {
  const root = createRoot(document.getElementById("root")!);
  const me = { userId: null, login: null, name: null, devices: new Set<string>() };
  const filters = { mine: false, group: null };
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(OnItsWay, { repository: repo, filters, onFilters: () => {}, me, focus: null }))); });
  expect(inGroup("you", 11)).toBe(true);
  expect(q("[data-deploy-on-its-way] h3")!.textContent).toContain("2 changes");

  await pressAside(11, "Set aside");
  expect(inGroup("you", 11)).toBe(false);
  expect(q("[data-deploy-on-its-way] h3")!.textContent).toContain("1 change");
  expect(Object.keys(store.getState().clientState.ui?.changes_set_aside ?? {})).toEqual([`${repo}:pr:11`]);
  await act(async () => { q('[data-change-fold="parked"]')!.click(); });
  expect(inGroup("parked", 11)).toBe(true);
  expect(q('[data-change-group="parked"] [data-change-parked-why]')!.textContent).toBe("set aside");

  await pressAside(11, "Bring back");
  expect(inGroup("you", 11)).toBe(true);
  expect(store.getState().clientState.ui?.changes_set_aside).toEqual({});
  await act(async () => { root.unmount(); });
});
