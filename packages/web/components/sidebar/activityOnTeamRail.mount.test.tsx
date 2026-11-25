// ct-101349: in the Modern focused rail, a member of a team (here 25 people)
// found Activity behind More, and paid a second click on every visit to the
// team feed. A team's rail keeps Activity on the root level, outside More.
// Run: cd packages/web && bun test --isolate components/sidebar/activityOnTeamRail.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/inbox", pretendToBeVisual: true });
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
const { ThemeContext } = await import("../ThemeProvider");
const { useInboxStore } = await import("../../store/inboxStore");
const { Sidebar } = await import("../Sidebar");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

test("a 25-person team's Modern focused rail has Activity on its root level, not behind More", async () => {
  const s = useInboxStore.getState() as any;
  useInboxStore.setState({
    currentUser: { ...(s.currentUser ?? {}), _id: "u1", _creationTime: Date.UTC(2026, 10, 1), name: "Member" },
    teams: [{ _id: "t1", name: "Team", member_count: 25, memberCount: 25 }],
    clientState: { ...s.clientState, ui: { ...(s.clientState?.ui ?? {}), active_team_id: "t1", modern_focused: true } },
  } as any);

  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const theme = { theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any;
  await act(async () => root.render(
    <ConvexProvider client={offlineConvexClient()}>
      <ThemeContext.Provider value={theme}>
        <MemoryRouter initialEntries={["/inbox"]}>
          <Sidebar isMobileOpen />
        </MemoryRouter>
      </ThemeContext.Provider>
    </ConvexProvider>,
  ));

  const scroll = host.querySelector("[data-sidebar-scroll]");
  expect(scroll).not.toBeNull();
  // The Modern focused rail is what rendered: its daily pages are on the root.
  expect(scroll!.querySelector('a[href="/inbox"]')).not.toBeNull();
  expect(scroll!.querySelector('a[href="/decisions"]')).not.toBeNull();
  // The row exists for this team (its gate is on): open More and it is there.
  const onRoot = !!scroll!.querySelector('a[href="/team/activity"]');
  const more = [...scroll!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "More");
  if (more) await act(async () => { more.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const inMore = !!host.querySelector('[data-sidebar-drill] a[href="/team/activity"]');
  expect(inMore || onRoot).toBe(true);
  // The miss: Activity is only reachable through More, never on the root rail.
  expect(onRoot).toBe(true);
  await act(async () => root.unmount());
});
