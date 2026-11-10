// The Modern session card mounted for real (jsdom, the real store, the theme
// context saying Modern): its one-row toolbar reaches every action, the card
// opens on a click and on Enter, the right-click menu gets the row, and a
// heartbeat on its session re-renders nothing (the inbox's heartbeat budget,
// held for the Modern card too).
import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html class=\"modern-style\"><body></body></html>", { url: "https://app.test/inbox", pretendToBeVisual: true });
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

const React = await import("react");
const { act, Profiler } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProvider } = await import("convex/react");
const { MemoryRouter } = await import("react-router");
const { offlineConvexClient } = await import("../../test-helpers/offlineConvex");
const { ThemeContext } = await import("../ThemeProvider");
const { useInboxStore } = await import("../../store/inboxStore");
const { SessionCard } = await import("./SessionCard");

const NOW = Date.now();
const ID = "jx7000000000000000000000000000mc1";
const row = {
  _id: ID,
  session_id: "s-mc1",
  agent_type: "claude_code",
  title: "Fix the auth race",
  message_count: 12,
  updated_at: NOW - 5 * 60_000,
  agent_status_updated_at: NOW - 5 * 60_000,
  started_at: NOW - 60 * 60_000,
  last_heartbeat: NOW - 1_000,
  is_idle: true,
  agent_status: "idle",
  has_pending: false,
  is_connected: true,
  project_path: "/src/codecast",
  git_root: "/src/codecast",
  user_id: "me",
  idle_summary: "Made the retry idempotent",
} as any;

useInboxStore.setState({ currentUser: { _id: "me", name: "Me" }, clientStateInitialized: true } as any);
useInboxStore.getState().syncTable("sessions", [row]);

const MODERN = { theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any;
const convex = offlineConvexClient("https://example.convex.cloud");
const calls: string[] = [];
let commits = 0;

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
const card = (props: Record<string, unknown> = {}) => (
  <ThemeContext.Provider value={MODERN}>
    <MemoryRouter>
      <ConvexProvider client={convex}>
        <Profiler id="card" onRender={() => { commits++; }}>
          <SessionCard
            session={row}
            isActive={false}
            globalIndex={0}
            sectionStatus="blocked"
            onSelect={(s, e) => calls.push(`select ${s._id} ${e ? "click" : "key"}`)}
            onDismiss={(id) => calls.push(`kill ${id}`)}
            onStash={(id) => calls.push(`stash ${id}`)}
            onPin={(id) => calls.push(`pin ${id}`)}
            onCardContextMenu={(_e, s, foreign) => calls.push(`menu ${s._id} ${foreign}`)}
            sessionLabel={null}
            isFavorite={false}
            {...props}
          />
        </Profiler>
      </ConvexProvider>
    </MemoryRouter>
  </ThemeContext.Provider>
);
await act(async () => { root.render(card()); });

const press = (el: Element | null) => act(async () => { el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });

describe("the Modern card, mounted", () => {
  test("draws one card with the state's word for its section", () => {
    expect(host.querySelectorAll("[data-session-id]")).toHaveLength(1);
    expect(host.querySelector("[data-session-id]")!.getAttribute("data-mc-status")).toBe("needs_you");
    expect(host.querySelector("[data-status-word]")!.textContent).toBe("Needs you");
    expect(host.querySelector("[data-sv-title]")!.textContent).toBe("Fix the auth race");
  });

  test("its four actions sit in one row and each reaches its handler", async () => {
    const tools = host.querySelector("[data-mc-tools]")!;
    const buttons = [...tools.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Pin", "Kill Session", "Label session", "Stash"]);
    // One row: every action is a direct child of the toolbar, which lays
    // them out side by side (flex, no wrap, no column).
    expect(buttons.every((b) => b.parentElement === tools)).toBe(true);
    expect(tools.className).toContain("flex items-center");
    expect(tools.className).not.toMatch(/flex-col|flex-wrap/);
    // Shown on hover and while the card holds keyboard focus.
    expect(tools.className).toContain("group-hover:opacity-100");
    expect(tools.className).toContain("group-focus-within:opacity-100");
    let opened = false;
    const openPalette = useInboxStore.getState().openPalette;
    useInboxStore.setState({ openPalette: (() => { opened = true; }) as any });
    calls.length = 0;
    for (const b of buttons) await press(b);
    useInboxStore.setState({ openPalette });
    expect(calls).toEqual([`pin ${ID}`, `kill ${ID}`, `stash ${ID}`]);
    expect(opened).toBe(true);
  });

  test("opens on a click and on Enter; the right-click menu gets the row", async () => {
    calls.length = 0;
    const body = host.querySelector("[data-session-id] > [role=button]")!;
    await press(body);
    await act(async () => { body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await act(async () => { host.querySelector("[data-session-id]")!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
    expect(calls).toEqual([`select ${ID} click`, `select ${ID} key`, `menu ${ID} false`]);
  });

  test("unread draws the edge bar; read does not", async () => {
    expect(host.querySelector("[data-mc-unread-bar]")).toBeNull();
    await act(async () => { root.render(card({ isUnread: true })); });
    expect(host.querySelector("[data-mc-unread-bar]")).not.toBeNull();
    expect(host.querySelector("[data-session-id]")!.getAttribute("data-mc-unread")).toBe("true");
    await act(async () => { root.render(card()); });
  });

  test("a heartbeat on its session commits nothing and changes nothing in the DOM", async () => {
    let mutations = 0;
    const mo = new dom.window.MutationObserver((records) => { mutations += records.length; });
    mo.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
    commits = 0;
    await act(async () => {
      const current = useInboxStore.getState().sessions[ID] as any;
      useInboxStore.getState().syncTable("sessions", [{ ...current, last_heartbeat: Date.now(), updated_at: current.updated_at }] as any, { isDelta: true } as any);
    });
    mutations += mo.takeRecords().length;
    mo.disconnect();
    expect(commits).toBe(0);
    expect(mutations).toBe(0);
  });

  test("a set-aside card offers Restore and Kill in the same row", async () => {
    await act(async () => { root.render(card({ variant: "stashed", onRestore: (id: string) => calls.push(`restore ${id}`), onKill: (id: string) => calls.push(`kill-aside ${id}`), onDismiss: undefined, onStash: undefined, onPin: undefined })); });
    const tools = host.querySelector("[data-mc-tools]")!;
    expect([...tools.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Restore", "Kill Session"]);
    expect(host.querySelector("[data-status-word]")!.textContent).toBe("Stashed");
    calls.length = 0;
    for (const b of tools.querySelectorAll("button")) await press(b);
    expect(calls).toEqual([`restore ${ID}`, `kill-aside ${ID}`]);
    await act(async () => { root.unmount(); });
  });
});
