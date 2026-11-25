import { afterAll, expect, mock, test } from "bun:test";
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../test-helpers/domGlobals";

// ct-101480: the top bar's Back and Forward followed different histories.
// In Modern, Back (nav.back) walked the tab's trail and pushed the page it
// landed on, while Forward called window.history.forward(), a stack Back never
// wrote to: Forward after Back went nowhere, and the person lost their place.
// Back and then Forward must return to the page they pressed Back on.

const dom = new JSDOM(`<!doctype html><html class="modern-style"><body><div id="root"></div></body></html>`, { url: "https://local.codecast.sh/tasks" });
const keys = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"];
const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
for (const k of keys) {
  Object.defineProperty(globalThis, k, { value: k === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[k], configurable: true, writable: true });
}

// The browser's history, as a stack the app's moves write to: a router push
// drops everything ahead of the cursor, back and forward move the cursor and
// fire popstate, as the browser does.
const browser = { stack: ["/tasks"], at: 0 };
const here = () => browser.stack[browser.at];
let onMove: () => void = () => {};
function pushPage(path: string) {
  browser.stack = [...browser.stack.slice(0, browser.at + 1), path];
  browser.at = browser.stack.length - 1;
  onMove();
}
function traverse(delta: number) {
  const next = browser.at + delta;
  if (next < 0 || next >= browser.stack.length) return;
  browser.at = next;
  dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  onMove();
}
Object.defineProperty(dom.window.history, "back", { value: () => traverse(-1), configurable: true });
Object.defineProperty(dom.window.history, "forward", { value: () => traverse(1), configurable: true });
Object.defineProperty(dom.window.history, "go", { value: (d = 0) => traverse(d), configurable: true });

mock.module("next/navigation", () => ({
  usePathname: () => here(),
  useRouter: () => ({ push: pushPage, replace: pushPage, back: () => traverse(-1), forward: () => traverse(1) }),
  useSearchParams: () => new URLSearchParams(),
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ShortcutProvider, useShortcuts } = await import("./ShortcutProvider");
const { useGlobalShortcutActions } = await import("./actions");
const { useInboxStore } = await import("../store/inboxStore");
const { startNavTrail } = await import("../lib/navTrailRecorder");

// The active app tab shows whatever the browser is on.
const showHere = () => useInboxStore.setState({ tabs: [{ id: "tab-1", path: here() }], activeTabId: "tab-1", showMySessions: false } as any);
onMove = showHere;
showHere();
const stopTrail = startNavTrail();

let dispatch!: ReturnType<typeof useShortcuts>["dispatchAction"];
function Host() {
  useGlobalShortcutActions();
  dispatch = useShortcuts().dispatchAction;
  return null;
}
const root = createRoot(document.getElementById("root")!);
await act(async () => { root.render(<MemoryRouter initialEntries={["/tasks"]}><ShortcutProvider><Host /></ShortcutProvider></MemoryRouter>); });

const settle = () => new Promise((r) => setTimeout(r, 10));
async function press(action: "nav.back" | "nav.forward") {
  await act(async () => { dispatch(action); });
  await settle();
}

afterAll(async () => {
  stopTrail();
  await act(async () => { root.unmount(); });
  closeDomWindow(dom);
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
});

test("Forward undoes Back: Back from Plans lands on Tasks, Forward returns to Plans, Back again to Tasks", async () => {
  await settle();
  pushPage("/plans");
  await settle();
  expect(here()).toBe("/plans");

  await press("nav.back");
  expect(here()).toBe("/tasks");

  await press("nav.forward");
  expect(here()).toBe("/plans");

  await press("nav.back");
  expect(here()).toBe("/tasks");
});

test("the top bar's Forward button goes through nav.forward, as its Back button goes through nav.back", () => {
  const src = readFileSync(join(import.meta.dir, "../components/DashboardLayout.tsx"), "utf8");
  const button = (label: string) => {
    const at = src.indexOf(`aria-label="${label}"`);
    expect(at).toBeGreaterThan(-1);
    return src.slice(src.lastIndexOf("onClick", at), at);
  };
  expect(button("Go back")).toContain(`dispatchAction("nav.back")`);
  expect(button("Go forward")).toContain(`dispatchAction("nav.forward")`);
});
