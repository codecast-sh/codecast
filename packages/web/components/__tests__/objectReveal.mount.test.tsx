import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../test-helpers/globals";

// The revealed page is a probe: it drives the band's pane-local router the way
// a task page's session card does (useOpenLinkedSession → router.push).
mock.module("../RoutePane", () => ({
  RoutePane: ({ path, navigate }: { path: string; navigate: (p: string, mode: "push" | "replace") => void }) => (
    <div data-route-pane={path}>
      <button data-open-session onClick={() => navigate("/conversation/A", "push")} />
      <button data-open-message onClick={() => navigate("/conversation/B#msg-m1", "push")} />
      <button data-open-detail onClick={() => navigate("/tasks/ct-2", "push")} />
    </div>
  ),
}));

import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { declareViewNav } from "../../store/viewNav";
import { RevealAncestryCtx, useRevealHost } from "../../lib/revealHost";
import { RevealHost } from "../ObjectReveal";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/inbox" });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400 }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");

// jsdom lays nothing out: the band's scroll follow is a no-op here.
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const tab = (): AppTab => ({ id: "t1", title: "Inbox", path: "/inbox", createdAt: 0 });
beforeEach(() => {
  declareViewNav("gesture");
  useInboxStore.setState({ tabs: [tab()], activeTabId: "t1", sessions: {}, currentSessionId: null, viewingDismissedId: null } as any);
});

function Pill({ href }: { href: string }) {
  const host = useRevealHost()!;
  return <button data-pill onClick={() => host.toggle({ href, title: href })} />;
}

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<MemoryRouter initialEntries={["/inbox"]}>{ui}</MemoryRouter>));
  const click = (sel: string) => act(() => { (container.querySelector(sel) as HTMLElement).click(); });
  return { container, click, unmount: () => act(() => root.unmount()) };
}

// Regression: a task revealed inside conversation A lists A among its sessions;
// clicking that card re-pointed the band at /conversation/A, so A rendered
// inside itself with the same band open — two headers alternating on screen.
test("a session opened from inside a band goes to the stage, and the band stays on its page", async () => {
  const m = await mount(
    <RevealAncestryCtx.Provider value={["A"]}>
      <RevealHost><Pill href="/tasks/ct-1" /></RevealHost>
    </RevealAncestryCtx.Provider>,
  );
  try {
    await m.click("[data-pill]");
    expect(m.container.querySelector("[data-route-pane]")?.getAttribute("data-route-pane")).toBe("/tasks/ct-1");

    await m.click("[data-open-session]");
    // The inbox hosts the band, so the click selects the session in place.
    expect(useInboxStore.getState().currentSessionId).toBe("A");
    expect(m.container.querySelector("[data-route-pane]")?.getAttribute("data-route-pane")).toBe("/tasks/ct-1");
    expect(m.container.querySelector("[data-reveal-nested]")).toBeNull();

    // A message deep link keeps its target: it rides the host's router.
    await m.click("[data-open-message]");
    expect(useInboxStore.getState().tabs[0].path).toBe("/conversation/B#msg-m1");
    expect(m.container.querySelector("[data-route-pane]")?.getAttribute("data-route-pane")).toBe("/tasks/ct-1");

    // The page's own list → detail still stays in the band.
    await m.click("[data-open-detail]");
    expect(m.container.querySelector("[data-route-pane]")?.getAttribute("data-route-pane")).toBe("/tasks/ct-2");

    // Escape from inside the band closes it — the quick way back.
    await act(() => {
      m.container.querySelector("[data-open-detail]")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(m.container.querySelector("[data-route-pane]")).toBeNull();
  } finally {
    await m.unmount();
  }
}, { timeout: 30_000 });

test("a band never shows a conversation it is already inside", async () => {
  const m = await mount(
    <RevealAncestryCtx.Provider value={["outer", "A"]}>
      <RevealHost><Pill href="/conversation/A" /></RevealHost>
    </RevealAncestryCtx.Provider>,
  );
  try {
    await m.click("[data-pill]");
    expect(m.container.querySelector("[data-reveal-nested]")).not.toBeNull();
    expect(m.container.textContent).toContain("This is the conversation you are reading");
  } finally {
    await m.unmount();
  }
}, { timeout: 30_000 });
