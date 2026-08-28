import { beforeAll, describe, expect, mock, test } from "bun:test";

// ct-46126. TabContent's kept-mounted pane set and its one-shot adoption of
// the entry URL both lived in component scope, but the component itself
// remounts whenever the layout around it changes shape (the stage Group used
// to appear and disappear with the companion pane). A remount then (1) wiped
// the pane set, so every background tab's DOM was destroyed and rebuilt cold
// on the next visit, and (2) re-armed the entry-URL adoption, which stamped
// the PREVIOUS tab's URL into the tab being switched to — corrupting stored
// tab paths. Both now live on globalThis, scoped to the document load. This
// test mounts TabContent, visits two tabs, then unmounts and remounts it and
// asserts both panes survive and no tab path is rewritten.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/inbox",
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// -- Minimal store: just what TabContent reads --

type Tab = { id: string; path: string; title: string };
const state: {
  tabs: Tab[];
  activeTabId: string;
  switchTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
} = {
  tabs: [
    { id: "tab_a", path: "/inbox", title: "Inbox" },
    { id: "tab_b", path: "/tasks", title: "Tasks" },
  ],
  activeTabId: "tab_a",
  switchTab: (id) => { state.activeTabId = id; notify(); },
  updateTab: (id, patch) => {
    updateTabCalls.push({ id, patch });
    state.tabs = state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
    notify();
  },
};
const updateTabCalls: Array<{ id: string; patch: Partial<Tab> }> = [];
let version = 0;
const listeners = new Set<() => void>();
function notify() { version++; for (const l of listeners) l(); }

// The tab fields are driven by this file; everything else stays the real state,
// because the substitution answers every file that runs after this one too (see
// mockInboxStore). `useTrackedStore` is replaced as well: it has to re-render on
// `notify`, which the real one knows nothing about.
const { mockInboxStore } = await import("./mockInboxStore");
const readState = mockInboxStore(() => state, {
  useTrackedStore: (_deps: unknown[]) => {
    const React = require("react");
    React.useSyncExternalStore(
      (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
      () => version,
    );
    return readState();
  },
});

// lib/pageLayout, lib/openIntent and lib/tabTitle are NOT substituted. They
// used to be, and it cost a sibling: `mock.module` is process-global, so
// `isFullWidthRoute: () => true` answered lib/__tests__/pageLayout.test.ts too
// and failed its three negative cases. Spreading the real module would not have
// helped — the lie was the overridden export itself, not the dropped ones.
// Nothing was gained by any of the three: /inbox and /tasks are both genuinely
// full-width, the prewarm set is empty in a fresh process, and neither tab
// carries a session id. The real modules answer exactly what the stubs did.
mock.module("../../hooks/useConversationMessages", () => ({
  useConversationMessages: () => {},
}));
// The two routes this test renders; every other lazyPage loader stays cold.
mock.module("@/app/inbox/page", () => ({ default: () => <div data-page="inbox" /> }));
mock.module("@/app/tasks/page", () => ({ default: () => <div data-page="tasks" /> }));

const { TabContent } = await import("../TabContent");
const React = await import("react");
const { createRoot } = await import("react-dom/client");

const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

function panes(): Array<{ id: string; display: string }> {
  return [...document.querySelectorAll<HTMLElement>("[data-tab-id]")].map((el) => ({
    id: el.getAttribute("data-tab-id")!,
    display: el.style.display,
  }));
}

describe("TabContent survives its own remount", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeAll(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<TabContent />));
    // Lazy pages resolve a microtask later.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  });

  test("visited tabs keep hidden panes across a switch", async () => {
    expect(panes()).toEqual([{ id: "tab_a", display: "block" }]);

    await act(async () => state.switchTab("tab_b"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    expect(panes()).toEqual([
      { id: "tab_a", display: "none" },
      { id: "tab_b", display: "block" },
    ]);
  });

  test("a remount neither drops panes nor rewrites tab paths", async () => {
    updateTabCalls.length = 0;

    // The layout flip: everything below the swapped wrapper unmounts, then a
    // fresh TabContent mounts in the new branch.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<TabContent />));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    // Both visited tabs come back (the active one visible, the other warm and
    // hidden) — before the fix only the active pane survived.
    expect(panes()).toEqual([
      { id: "tab_a", display: "none" },
      { id: "tab_b", display: "block" },
    ]);

    // The entry URL (still /inbox in the address bar) must NOT be stamped into
    // the active /tasks tab — before the fix the remount re-armed the one-shot
    // adoption and rewrote the tab's path to wherever the address bar pointed.
    expect(updateTabCalls).toEqual([]);
    expect(state.tabs.find((t) => t.id === "tab_b")!.path).toBe("/tasks");
  });
});
