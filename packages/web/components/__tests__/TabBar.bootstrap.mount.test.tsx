// The tab bar opens the first tab for a window that has none. StrictMode
// runs that effect twice on the first mount in development, and each run
// opened a tab, so a new account's first screen carried two tabs both named
// "Inbox" over its one conversation.
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/inbox", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { TabBar } = await import("../TabBar");
const { useInboxStore } = await import("../../store/inboxStore");

test("a window with no tab gets exactly one, and so no tab strip", async () => {
  useInboxStore.setState({ tabs: [], activeTabId: null });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<StrictMode><TabBar /></StrictMode>));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const { tabs, activeTabId } = useInboxStore.getState();
  expect(tabs.map((t) => t.path)).toEqual(["/inbox"]);
  expect(activeTabId).toBe(tabs[0].id);
  expect(document.querySelector("[data-cc-tabbar]")).toBeNull();
  await act(async () => root.unmount());
});
