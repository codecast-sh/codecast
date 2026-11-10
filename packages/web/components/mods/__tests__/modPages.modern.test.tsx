import { test, expect, mock } from "bun:test";

// Mods and a mod kind's list in the Modern style: the shared page header names
// each page (Classic keeps the pages' own headers, ModTree.mount.test.tsx).
// Run: cd packages/web && bun test --isolate components/mods/__tests__/modPages.modern.test.tsx
mock.module("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));

const { JSDOM } = await import("jsdom");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { replaceGlobals } = await import("../../../test-helpers/globals");
const { useInboxStore } = await import("../../../store/inboxStore");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../../test-helpers/offlineConvex");
const { ThemeContext } = await import("../../ThemeProvider");
const { ObjectsPage } = await import("../ObjectsPage");
const { ModsPage } = await import("../ModsPage");

(globalThis as any).__inboxStore = useInboxStore;
const client = offlineConvexClient("https://example.convex.cloud");

async function mount(node: React.ReactNode): Promise<{ root: HTMLElement; done: () => Promise<void> }> {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://codecast.test/mods" });
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const restore = replaceGlobals({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver });
  const el = dom.window.document.getElementById("root")!;
  const root = createRoot(el);
  await act(() => root.render(
    <ThemeContext.Provider value={{ theme: "dark", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} }}>
      <ConvexProvider client={client}><MemoryRouter>{node}</MemoryRouter></ConvexProvider>
    </ThemeContext.Provider>,
  ));
  return { root: el as unknown as HTMLElement, done: async () => { await act(() => root.unmount()); restore(); } };
}

const seed = () => useInboxStore.setState({
  currentUser: { _id: "u1", name: "Me" },
  clientState: { ...(useInboxStore.getState() as any).clientState, ui: { ...((useInboxStore.getState() as any).clientState?.ui ?? {}), active_team_id: undefined } },
  mods: { m1: { _id: "m1", name: "bug-desk", title: "Bug Desk", is_mine: true, enabled: true, code: "", rev: 1, version: 0, updated_at: 1,
    manifest: { name: "bug-desk", objects: [{ prefix: "bug", title: "Bug", plural: "Bugs", statuses: ["triage", "open", "fixed"], fields: {} }] } } },
  modObjects: {
    o1: { _id: "o1", user_id: "u1", workspace: "user:u1", short_id: "bug-1", prefix: "bug", title: "First bug", status: "triage", fields: {}, updated_at: 2, created_at: 1 },
  },
} as any);

test("a mod kind's list is named by the shared header, its mod the crumb", async () => {
  seed();
  const m = await mount(<ObjectsPage prefix="bug" />);
  try {
    const bar = m.root.querySelector("header[data-cc-page-head]")!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector("h1")?.textContent).toBe("Bugs");
    expect(bar.querySelector("[data-cc-page-count]")?.textContent).toBe("1");
    expect(bar.textContent).toContain("Bug Desk");
    expect(m.root.textContent).toContain("First bug");
  } finally { await m.done(); }
});

test("Mods is named by the shared header", async () => {
  seed();
  const m = await mount(<ModsPage />);
  try {
    const bar = m.root.querySelector("header[data-cc-page-head]")!;
    expect(bar.querySelector("h1")?.textContent).toBe("Mods");
    expect(m.root.querySelectorAll("h1")).toHaveLength(1);
  } finally { await m.done(); }
});
