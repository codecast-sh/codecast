import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// A shared link opened in a fresh tab lands where it points even when the stored
// active tab id is missing or stale. The shell renders the entry address in the
// first tab then; its one-shot adoption used to bail on the missing id, and the
// stale-id repair right after switched to that first tab with its OLD path, so
// /flows/pipeline?repo=… opened after a visit to /flows landed on /flows.

import { JSDOM } from "jsdom";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/inbox",
  pretendToBeVisual: true,
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Element: dom.window.Element,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

type Tab = { id: string; path: string; title: string };
const state: {
  tabs: Tab[];
  activeTabId: string | null;
  switchTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
} = {
  // The stored active id names a tab that no longer exists; the one tab left was last on /tasks.
  tabs: [{ id: "tab_a", path: "/tasks", title: "Tasks" }],
  activeTabId: "tab_gone",
  switchTab: (id) => { switches.push(id); state.activeTabId = id; notify(); },
  updateTab: (id, patch) => { state.tabs = state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)); notify(); },
};
const switches: string[] = [];
let version = 0;
const listeners = new Set<() => void>();
function notify() { version++; for (const l of listeners) l(); }

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

mock.module("../../hooks/useConversationMessages", () => ({ useConversationMessages: () => {} }));
mock.module("@/app/inbox/page", () => ({ default: () => <div data-page="inbox" /> }));
mock.module("@/app/tasks/page", () => ({ default: () => <div data-page="tasks" /> }));

const { TabContent } = await import("../TabContent");
const { MemoryRouter } = await import("react-router");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

describe("an entry address with a stale active tab", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeAll(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Its own location key: the adoption runs once per router location it enters on.
    await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: "/inbox", key: "entry-stale" }]}><TabContent /></MemoryRouter>));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  });

  afterAll(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  test("lands in the tab it rendered in, at the address it was opened on", () => {
    expect(state.tabs[0].path).toBe("/inbox");
    expect(state.activeTabId).toBe("tab_a");
    expect(switches).toEqual(["tab_a"]);
  });
});
