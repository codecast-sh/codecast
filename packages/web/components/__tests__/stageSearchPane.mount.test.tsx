import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act, createContext } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../test-helpers/globals";

mock.module("../AuthGuard", () => ({ AuthGuard: ({ children }: { children: React.ReactNode }) => children }));
mock.module("../DashboardLayout", () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => children }));
mock.module("../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));

import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { stageRenderLayout } from "../../lib/stage";
import { tabNavigate } from "../../src/compat/tabRouting";
import StageSplitView from "../stage/StageSplitView";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/inbox" });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400 }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { dom.window.close(); restoreGlobals(); });

const tab = (): AppTab => ({ id: "t1", title: "Inbox", path: "/inbox", createdAt: 0 });
beforeEach(() => { useInboxStore.setState({ tabs: [tab()], activeTabId: "t1" } as any); });

function Stage() {
  const t = useInboxStore((s) => s.tabs.find((x) => x.id === "t1")!);
  return <StageSplitView tab={t} layout={stageRenderLayout(t, false)} isTabActive />;
}
const g = globalThis as any;
const Nest: React.Context<boolean> = (g.__DashboardNestCtx ??= createContext(false));

const settle = async (container: HTMLElement, sel: string) => {
  for (let i = 0; i < 60; i++) {
    await act(() => new Promise<void>((r) => setTimeout(r, 100)));
    if (container.querySelector(sel)) return true;
  }
  return false;
};

test("navigating the active tab to /search?q=… renders the search page in the solo stage", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<MemoryRouter><Nest.Provider value={true}><Stage /></Nest.Provider></MemoryRouter>));
    await act(() => { tabNavigate("/search?q=deploy", "push"); });
    const ok = await settle(container, 'input[placeholder^="Search every session"]');
    expect(ok).toBe(true);
    expect((container.querySelector('input[placeholder^="Search every session"]') as HTMLInputElement).value).toBe("deploy");
  } finally {
    await act(() => root.unmount());
  }
}, { timeout: 30_000 });
