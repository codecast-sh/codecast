// Which level of the Modern rail is open (hooks/useRailLevel). A full load of
// /ops in a tab that showed a chat room earlier once landed on the Chat level
// (the tab's last path renders first, then the URL's): a level the route
// opened must close when the route leaves it. A level the person opened by
// hand stays while they move around, and Back always returns to the root.
// Run: cd packages/web && bun test --isolate components/sidebar/modernRailLevel.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/ops", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  indexedDB,
  IDBKeyRange,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { TeamFeatureOverride } = await import("../../lib/teamFeatures");
const { useRailLevel } = await import("../../hooks/useRailLevel");
const { ModernSidebar } = await import("./ModernSidebar");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

type L = "chat" | "tasks" | "more";
const ALL: Record<L, boolean> = { chat: true, tasks: true, more: true };

/** The hook under a route, with its handles kept for the test to press. */
async function levels() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  let api: ReturnType<typeof useRailLevel<L>> | null = null;
  function Probe({ route }: { route: L | null }) {
    api = useRailLevel<L>(route, ALL);
    return null;
  }
  const at = async (route: L | null) => { await act(async () => root.render(<Probe route={route} />)); return api!.level; };
  const press = async (f: (a: NonNullable<typeof api>) => void) => { await act(async () => f(api!)); return api!.level; };
  return { at, press, done: () => act(async () => root.unmount()) };
}

test("a level the route opened closes when the route leaves it", async () => {
  const l = await levels();
  expect(await l.at("chat")).toBe("chat");
  expect(await l.at(null)).toBeNull();
  // Arriving in another section opens its level instead.
  expect(await l.at("chat")).toBe("chat");
  expect(await l.at("tasks")).toBe("tasks");
  await l.done();
});

test("a level opened by hand stays as the person moves, until Back or another section", async () => {
  const l = await levels();
  expect(await l.at(null)).toBeNull();
  expect(await l.press((a) => a.open("chat"))).toBe("chat");
  expect(await l.at("chat")).toBe("chat");
  // A session opened from the side panel keeps them in Chat.
  expect(await l.at(null)).toBe("chat");
  expect(await l.press((a) => a.back())).toBeNull();
  // More, opened by hand, gives way to the level of a section they arrive in.
  expect(await l.press((a) => a.open("more"))).toBe("more");
  expect(await l.at("tasks")).toBe("tasks");
  await l.done();
});

test("Back always returns to the root, even on a route that belongs to the level", async () => {
  const l = await levels();
  expect(await l.at("chat")).toBe("chat");
  expect(await l.press((a) => a.back())).toBeNull();
  // Still on that route: it stays shut until the person opens it or the route moves.
  expect(await l.at("chat")).toBeNull();
  expect(await l.press((a) => a.open("chat"))).toBe("chat");
  await l.done();
});

test("the Modern rail at /ops, after the tab showed a chat room, renders the root groups", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const noop = () => {};
  const rail = (pathname: string) => (
    <ConvexProvider client={offlineConvexClient()}>
      <TeamFeatureOverride.Provider value={{ chat: true }}>
        <MemoryRouter>
          <ModernSidebar
            isMobileOpen
            isNarrow={false}
            peek={false}
            pathname={pathname}
            titlebarStripRef={noop}
            pinnedRail={null}
            taskViewItems={[]}
            docViewItems={[]}
            decisionViewItems={[]}
            viewSectionOverride={{}}
            setViewSectionOverride={noop}
            bookmarkRows={null}
            folderRows={null}
            appFooter={null}
            openCompose={noop}
            counts={{ bookmarks: 0, folders: 0 }}
            hasTeam
            hasTeams={false}
            focus={{ offered: false, focused: false }}
          />
        </MemoryRouter>
      </TeamFeatureOverride.Provider>
    </ConvexProvider>
  );
  const levelOpen = () => !host.querySelector("[data-sidebar-drill]")!.hasAttribute("inert");
  const rootOpen = () => !host.querySelector("[data-sidebar-scroll]")!.hasAttribute("inert");

  // The tab's stored path renders first: Chat's level, as the route belongs to it.
  await act(async () => root.render(rail("/chat/c1")));
  expect(levelOpen()).toBe(true);
  // Then the URL's own page: the root rail, with its groups and Ops lit.
  await act(async () => root.render(rail("/ops")));
  expect(levelOpen()).toBe(false);
  expect(rootOpen()).toBe(true);
  const scroll = host.querySelector("[data-sidebar-scroll]")!;
  for (const group of ["top", "team", "work", "automation", "code"]) expect(scroll.querySelector(`[data-rail-group="${group}"]`)).not.toBeNull();
  expect(scroll.querySelector('a[href="/ops"][aria-current="page"]')).not.toBeNull();
  // A full load straight onto /ops starts on the root rail too.
  await act(async () => root.unmount());
  const fresh = createRoot(host);
  await act(async () => fresh.render(rail("/ops")));
  expect(levelOpen()).toBe(false);
  await act(async () => fresh.unmount());
});
