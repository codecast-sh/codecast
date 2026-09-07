import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore } from "../../store/inboxStore";
import { KeyboardShortcutsPanel } from "../KeyboardShortcutsHelp";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
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
