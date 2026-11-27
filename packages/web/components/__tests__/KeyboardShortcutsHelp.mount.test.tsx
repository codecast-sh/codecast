import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore } from "../../store/inboxStore";
import { KeyboardShortcutsPanel, MenuKeyCaps } from "../KeyboardShortcutsHelp";
import { setKeyBindings } from "../../shortcuts/registry";
import { setLegendTab } from "../../lib/iconLegend";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

test("closed content waits for first open and survives close/reopen", async () => {
  const initial = useInboxStore.getState().shortcutsPanelOpen;
  useInboxStore.setState({ shortcutsPanelOpen: false });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() => root.render(<KeyboardShortcutsPanel />));
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.style.width).toBe("0px");
    expect(container.querySelector("kbd") === null).toBe(true);
    await act(() => useInboxStore.getState().toggleShortcutsPanel());
    expect(container.firstElementChild === panel).toBe(true);
    expect(panel.style.width).toBe("320px");
    const key = container.querySelector("kbd");
    expect(key !== null).toBe(true);
    expect(container.textContent).toContain("Shortcuts");
    await act(() => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })); });
    expect(panel.style.width).toBe("0px");
    expect(container.querySelector("kbd") === key).toBe(true);
    await act(() => useInboxStore.getState().toggleShortcutsPanel());
    expect(panel.style.width).toBe("320px");
    expect(container.querySelector("kbd") === key).toBe(true);
  } finally {
    await act(() => root.unmount());
    useInboxStore.setState({ shortcutsPanelOpen: initial });
  }
});

test("an on-screen hint follows a rebinding without remounting", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const caps = () => [...container.querySelectorAll("kbd")].map((k) => k.textContent).join(" ");
  try {
    await act(() => root.render(<MenuKeyCaps action="list.search" />));
    expect(caps()).toBe("/");
    await act(() => setKeyBindings([{ action: "list.search", keys: ["f"] }]));
    expect(caps()).toBe("F");
    await act(() => setKeyBindings([{ action: "list.search", keys: [] }]));
    expect(caps()).toBe("");
  } finally {
    setKeyBindings([]);
    await act(() => root.unmount());
  }
});

test("the Icons tab reads the page only while it shows", async () => {
  const initial = useInboxStore.getState().shortcutsPanelOpen;
  useInboxStore.setState({ shortcutsPanelOpen: true });
  // Count the observers the panel makes and the ones still watching.
  let made = 0;
  let live = 0;
  const Real = dom.window.MutationObserver;
  class Counting extends Real {
    constructor(cb: MutationCallback) { super(cb); made++; }
    observe(target: Node, opts?: MutationObserverInit) { live++; super.observe(target, opts); }
    disconnect() { live--; super.disconnect(); }
  }
  const restore = replaceGlobals({ MutationObserver: Counting });
  const container = document.createElement("div");
  const root = createRoot(container);
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  try {
    await act(() => root.render(<KeyboardShortcutsPanel />));
    expect(tabs().map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([["Shortcuts", "true"], ["Icons", "false"]]);
    expect(container.querySelector("[data-icon-legend]")).toBe(null);
    expect(made).toBe(0);

    await act(() => tabs()[1].click());
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    // The first read waits out the panel's open transition.
    expect(container.querySelector("[data-icon-legend]")?.textContent).not.toContain("No icons on this screen");
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(container.querySelector("[data-icon-legend]")?.textContent).toContain("No icons on this screen");
    expect(container.querySelector("kbd")).not.toBe(null); // the footer stays
    expect([made, live]).toEqual([1, 1]);

    // Closing the panel stops reading the page, though the tab stays chosen.
    await act(() => useInboxStore.getState().toggleShortcutsPanel());
    expect(container.querySelector("[data-icon-legend]")).toBe(null);
    expect(live).toBe(0);

    await act(() => useInboxStore.getState().toggleShortcutsPanel());
    await act(() => tabs()[0].click());
    expect(container.querySelector("[data-icon-legend]")).toBe(null);
    expect([made, live]).toEqual([2, 0]);
  } finally {
    await act(() => root.unmount());
    restore();
    setLegendTab("shortcuts");
    useInboxStore.setState({ shortcutsPanelOpen: initial });
  }
});

test("below sm the panel is a full-width sheet over the page, hidden while closed; from sm up the 320px column is unchanged", async () => {
  const initial = useInboxStore.getState().shortcutsPanelOpen;
  useInboxStore.setState({ shortcutsPanelOpen: false });
  const container = document.createElement("div");
  const root = createRoot(container);
  const cls = () => (container.firstElementChild as HTMLElement).className.split(/\s+/);
  try {
    await act(() => root.render(<KeyboardShortcutsPanel />));
    const panel = container.firstElementChild as HTMLElement;
    // The icon legend reads the page under a floating sheet (lib/iconLegend isOnScreen keys on this mark).
    expect(panel.hasAttribute("data-legend-sheet")).toBe(true);
    expect(cls()).toContain("max-sm:hidden");
    await act(() => useInboxStore.getState().toggleShortcutsPanel());
    for (const c of ["max-sm:fixed", "max-sm:inset-x-0", "max-sm:bottom-0", "max-sm:!w-full", "max-sm:h-[70dvh]"]) expect(cls()).toContain(c);
    expect(cls()).not.toContain("max-sm:hidden");
    expect((panel.firstElementChild as HTMLElement).className).toContain("max-sm:w-full");
    // Desktop keeps the column: its width is still the 320px the page sits beside.
    expect(panel.style.width).toBe("320px");
  } finally {
    act(() => root.unmount());
    useInboxStore.setState({ shortcutsPanelOpen: initial });
  }
});
