// ct-101410: writing about a page while looking at it. A session row in the
// rail, seen from a page (here /priorities) on a wide screen, offers a visible
// "open beside" control. One press opens the session as a pane beside the page
// through the stage's own openBeside(sessionPanePath(id)), and does NOT run the
// row's plain open (which leaves the page for /inbox?s=). Both card styles the
// rail draws (classic and Modern) carry it.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/priorities", pretendToBeVisual: true });
Object.defineProperty(dom.window, "innerWidth", { value: 1440, configurable: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  PointerEvent: dom.window.MouseEvent,
  FocusEvent: dom.window.FocusEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  DocumentFragment: dom.window.DocumentFragment,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).getComputedStyle ??= dom.window.getComputedStyle.bind(dom.window);
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// Spy on the stage's split without replacing the rest of it.
const besideCalls: string[] = [];
const realStage = { ...(await import("../../lib/stage")) };
mock.module("../../lib/stage", () => ({
  ...realStage,
  openBeside: (path: string, opts?: { reuse?: boolean }) => { besideCalls.push(path); void opts; return true; },
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProvider } = await import("convex/react");
const { MemoryRouter } = await import("react-router");
const { offlineConvexClient } = await import("../../test-helpers/offlineConvex");
const { ThemeContext } = await import("../ThemeProvider");
const { useInboxStore } = await import("../../store/inboxStore");
const { SessionCard } = await import("./SessionCard");

const NOW = Date.now();
const ID = "jx7000000000000000000000000000ob1";
const row = {
  _id: ID,
  session_id: "s-ob1",
  agent_type: "claude_code",
  title: "New session",
  message_count: 3,
  updated_at: NOW - 60_000,
  started_at: NOW - 10 * 60_000,
  last_heartbeat: NOW - 1_000,
  is_idle: true,
  agent_status: "idle",
  has_pending: false,
  is_connected: true,
  project_path: "/src/codecast",
  git_root: "/src/codecast",
  user_id: "me",
} as any;

useInboxStore.setState({ currentUser: { _id: "me", name: "Me" }, clientStateInitialized: true } as any);
useInboxStore.getState().syncTable("sessions", [row]);

const convex = offlineConvexClient("https://example.convex.cloud");
const style = (visualStyle: string) => ({ theme: "light", toggleTheme: () => {}, visualStyle, setVisualStyle: () => {} }) as any;

const OPEN_BESIDE = /open (it )?beside|open in split|split (view|pane)/i;
function besideControl(host: HTMLElement): HTMLElement | null {
  const all = [...host.querySelectorAll<HTMLElement>("button, [role=button], a")];
  return all.find((el) => OPEN_BESIDE.test(`${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`)) ?? null;
}

for (const visualStyle of ["classic", "modern"]) {
  describe(`a rail session row seen from /priorities (${visualStyle} card)`, () => {
    test("offers a visible open-beside control that splits instead of navigating", async () => {
      if (visualStyle === "modern") document.documentElement.classList.add("modern-style");
      else document.documentElement.classList.remove("modern-style");
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      const selects: string[] = [];
      await act(async () => {
        root.render(
          <ThemeContext.Provider value={style(visualStyle)}>
            <MemoryRouter initialEntries={["/priorities"]}>
              <ConvexProvider client={convex}>
                <SessionCard
                  session={row}
                  isActive={false}
                  globalIndex={0}
                  onSelect={(s) => selects.push(s._id)}
                  onClose={() => {}}
                  onPin={() => {}}
                  sessionLabel={null}
                  isFavorite={false}
                />
              </ConvexProvider>
            </MemoryRouter>
          </ThemeContext.Provider>,
        );
      });
      try {
        expect(host.querySelector("[data-session-id]")).not.toBeNull();
        const control = besideControl(host);
        expect(control, "no visible 'open beside' control on the rail's session row").not.toBeNull();
        besideCalls.length = 0;
        await act(async () => { control!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
        expect(besideCalls).toEqual([`/conversation/${ID}`]);
        expect(selects).toEqual([]);
      } finally {
        await act(async () => { root.unmount(); });
        host.remove();
      }
    });
  });
}
