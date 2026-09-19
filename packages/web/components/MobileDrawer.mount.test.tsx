// Mounts MobileDrawer (the phone slide-over for the shell's side rails) and
// checks the contract the shell relies on: a modal dialog named by its title,
// focus moved inside it, Escape and the header close both asking to close.
// Run: bun test components/MobileDrawer.mount.test.tsx
import { describe, expect, test } from "bun:test";

describe("MobileDrawer", () => {
  test("opens as a named modal dialog, traps focus, closes on Escape and the close button", async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
    // Radix's focus scope and dismiss layer walk the DOM through the element,
    // event and NodeFilter globals, so expose the whole DOM surface at once.
    const DOM_GLOBAL = /^(window|document|navigator|getComputedStyle|requestAnimationFrame|cancelAnimationFrame|Node|NodeFilter|Element|Text|Range|Selection|Document\w*|MutationObserver|DOMRect\w*|HTML\w*Element|SVG\w*Element|\w*Event)$/;
    for (const key of Object.getOwnPropertyNames(dom.window)) {
      if (DOM_GLOBAL.test(key)) Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
    }
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = React;
    const { MobileDrawer } = await import("./MobileDrawer");

    const closes: boolean[] = [];
    const root = createRoot(document.getElementById("root")!);
    const render = (open: boolean) =>
      act(async () => {
        root.render(
          React.createElement(MobileDrawer, { open, onOpenChange: (o: boolean) => closes.push(o), side: "left", title: "Menu" },
            React.createElement("nav", { "data-sv-nav": true }, React.createElement("button", { className: "w-full" }, "Inbox")),
          ),
        );
      });

    await render(true);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    // No description: the attribute must be absent, or Radix warns on every open.
    expect(dialog!.hasAttribute("aria-describedby")).toBe(false);
    expect(dialog!.classList.contains("cc-mobile-drawer")).toBe(true);
    expect(dialog!.getAttribute("data-cc-mobile-drawer")).toBe("left");
    // The dialog is named by the visible title.
    const labelId = dialog!.getAttribute("aria-labelledby");
    expect(labelId && document.getElementById(labelId)?.textContent).toBe("Menu");
    expect(dialog!.textContent).toContain("Inbox");
    // Focus lands inside the drawer, not on the page behind it.
    expect(dialog!.contains(document.activeElement)).toBe(true);

    await act(async () => {
      document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(closes).toEqual([false]);

    await act(async () => {
      (dialog!.querySelector('button[aria-label="Close menu"]') as HTMLElement).click();
    });
    expect(closes).toEqual([false, false]);

    await render(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  }, 240_000);
});
