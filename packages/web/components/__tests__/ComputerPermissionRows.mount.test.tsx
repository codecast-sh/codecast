import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";

// A desktop shell, faked at the bridge: `getComputerPermissions` is the read
// the app makes THROUGH THE CLI, and `openOsPermissionSettings` is the one
// gesture, so a test that drives those two drives the whole surface.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
let answer: Record<string, string> = { computerAccessibility: "unknown", computerScreen: "unknown" };
let settle: (() => void) | null = null;
const opened: string[] = [];
const bridge = {
  getComputerPermissions: () =>
    new Promise<Record<string, string>>((resolve) => {
      settle = () => resolve(answer);
    }),
  openOsPermissionSettings: async (kind: string) => {
    opened.push(kind);
  },
};
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { __CODECAST_ELECTRON__: bridge }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});

// Imported after the globals swap: the module installs its focus listener on
// whatever `window` is when it first subscribes.
const { ComputerPermissionRows } = await import("../permissions/ComputerPermissionRows");

const container = dom.window.document.createElement("div");
const root = createRoot(container as unknown as Element);

// Let the read that is in flight land, and React paint what came back.
async function land(next: Record<string, string>) {
  answer = next;
  await act(async () => {
    settle?.();
    await Promise.resolve();
  });
}

// Coming back to the window is what asks again — there is no change event for
// a TCC grant, so returning from System Settings is the signal.
async function refocus() {
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Promise.resolve();
  });
}

test("the rows report the helper's grants, and only a click takes the screen", async () => {
  await act(() => root.render(<ComputerPermissionRows />));

  // A read launches the helper and takes seconds, so the surface says it is
  // looking rather than letting two rows appear out of nowhere.
  expect(container.textContent).toContain("Checking what codecast computer is allowed to do");

  await land({ computerAccessibility: "not-a-state", computerScreen: "not-a-state" });
  // An answer we cannot read is "unknown", and an unknown draws no row at all
  // — never nag on unknown.
  expect(container.textContent).toBe("");

  await refocus();
  await land({ computerAccessibility: "off", computerScreen: "granted" });
  expect(container.textContent).toContain("Computer control");
  expect(container.textContent).toContain("Computer screenshots");
  // The missing one names the helper, not Codecast, and offers the only
  // gesture that fixes it.
  expect(container.textContent).toContain("codecast computer is not turned on in the Accessibility list yet.");
  expect(container.textContent).toContain("Open System Settings");
  // The granted one is done, with nothing to press.
  expect(container.textContent).toContain("On");

  // Nothing has been opened by the read itself.
  expect(opened).toEqual([]);

  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Open System Settings");
  expect(button).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  // The click opens the pane for THAT grant, through the helper's own window.
  expect(opened).toEqual(["computerAccessibility"]);

  // Coming back from System Settings re-reads without another click.
  await refocus();
  await land({ computerAccessibility: "granted", computerScreen: "granted" });
  expect(container.textContent).not.toContain("Open System Settings");

  await act(async () => root.unmount());
});
