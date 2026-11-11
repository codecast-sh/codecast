// The board's drill-in (FleetBoard FleetDrillIn), in Classic and Minimal:
// opening a tile lays the session over the board, and what it lays there is
// the session page every other way of opening a session shows
// (app/inbox/QueuePageClient SessionPage), with the overlay's own expand and
// close in its header. The overlay stays non-modal, so the triage chords keep
// reaching the drilled-in session, and Esc or ✕ returns to the board.
// Run: cd packages/web && bun test --isolate components/__tests__/fleetDrillIn.mount.test.tsx
import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { ReactNode } from "react";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/inbox", pretendToBeVisual: true });
const restore = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLAnchorElement: dom.window.HTMLAnchorElement,
  SVGElement: dom.window.SVGElement, Element: dom.window.Element, Node: dom.window.Node, DocumentFragment: dom.window.DocumentFragment,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent, PointerEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent, FocusEvent: dom.window.FocusEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  indexedDB: new IDBFactory(), IDBKeyRange,
});
afterAll(() => { closeDomWindow(dom); restore(); });

const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => null }));
// The session page itself is the inbox's (seatSessionPage.mount.test covers
// it); here it is a stand-in that shows what the drill-in hands it.
const seen: Array<{ sessionId: string; isIdle: boolean }> = [];
const inbox = { ...(await import("../../app/inbox/QueuePageClient")) };
mock.module("../../app/inbox/QueuePageClient", () => ({
  ...inbox,
  SessionPage: (props: { sessionId: string; isIdle: boolean; headerEnd?: ReactNode }) => {
    seen.push({ sessionId: props.sessionId, isIdle: props.isIdle });
    return <div data-session-page={props.sessionId}><div data-header-end>{props.headerEnd}</div></div>;
  },
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const cache = await import("../../store/idbCache");
let hydrated!: () => void;
const hydration = new Promise<void>((resolve) => { hydrated = resolve; });
const setHydrating = cache.setHydrating;
const hydrationSpy = spyOn(cache, "setHydrating").mockImplementation((value) => {
  setHydrating(value);
  if (!value) hydrated();
});
const { useInboxStore } = await import("../../store/inboxStore");
await hydration;
hydrationSpy.mockRestore();
const { ThemeContext } = await import("../ThemeProvider");
const { FleetBoard } = await import("../FleetBoard");
const { overlayConversationId } = await import("../../store/workspace");
const { MemoryRouter } = await import("react-router");

const ID = "jx7drill00000000000000000000000s1";
const NOW = Date.now();

async function mount(visualStyle: "classic" | "minimal") {
  useInboxStore.setState({
    currentUser: { _id: "u1", name: "Alex" }, clientStateInitialized: true,
    sessions: {
      [ID]: { _id: ID, session_id: "s-1", user_id: "u1", title: "Fix the flaky test", agent_type: "claude_code", message_count: 4, updated_at: NOW, started_at: NOW - 60_000, is_idle: true, agent_status: "idle", is_connected: true },
    },
  } as any);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(
    <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {}, visualStyle, setVisualStyle: () => {} } as any}>
      <MemoryRouter><FleetBoard /></MemoryRouter>
    </ThemeContext.Provider>,
  ));
  return { el, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

for (const visualStyle of ["classic", "minimal"] as const) {
  test(`${visualStyle}: a drilled-in tile shows the session page, non-modal, with the overlay's expand and close`, async () => {
    const { el, unmount } = await mount(visualStyle);
    try {
      seen.length = 0;
      await act(async () => { useInboxStore.getState().wsShow("secondary", { kind: "conversation", ref: ID }, { presentation: "overlay" }); });
      // The page loads on first use (the inbox module renders this board).
      await settle();
      const overlay = el.querySelector("[role='dialog']")!;
      expect(overlay.getAttribute("aria-modal")).toBe("false");
      expect(overlay.querySelector(`[data-session-page='${ID}']`)).not.toBeNull();
      expect(seen.at(-1)).toEqual({ sessionId: ID, isIdle: true });
      const controls = [...overlay.querySelectorAll("[data-header-end] button")].map((b) => b.getAttribute("aria-label"));
      expect(controls).toEqual(["Take the whole stage", "Close pane"]);

      // Esc returns to the board.
      await act(async () => {
        window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(overlayConversationId(useInboxStore.getState().workspace)).toBeNull();
      expect(el.querySelector("[data-session-page]")).toBeNull();

      // ✕ too.
      await act(async () => { useInboxStore.getState().wsShow("secondary", { kind: "conversation", ref: ID }, { presentation: "overlay" }); });
      await settle();
      await act(async () => { (el.querySelector("[data-header-end] button[aria-label='Close pane']") as HTMLButtonElement).click(); });
      expect(overlayConversationId(useInboxStore.getState().workspace)).toBeNull();
    } finally { await unmount(); }
  }, 30_000);
}
