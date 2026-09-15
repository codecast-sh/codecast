import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root" style="isolation:isolate;overflow:hidden;height:32px"></div><button id="outside">Outside</button></body></html>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: dom.window.MouseEvent });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { InboxViewMenu } = await import("../../InboxViewMenu");
const changes: string[] = [];

function Fixture() {
  const [value, setValue] = useState<"grouped" | "recent" | "time" | "bucket" | "plan" | "trigger">("grouped");
  return <InboxViewMenu value={value} onChange={(next) => { changes.push(next); setValue(next); }} hasLabels hasPlans hasTriggers />;
}

const container = document.getElementById("root")!;
const root = createRoot(container);
const trigger = () => container.querySelector<HTMLButtonElement>("button")!;
const menu = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Inbox view"]');
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

try {
  await act(() => root.render(<Fixture />));
  const firstTrigger = trigger();
  await act(() => firstTrigger.focus());
  assert.ok(trigger() === firstTrigger, "first focus must not replace the menu trigger");
  await act(() => firstTrigger.dispatchEvent(new dom.window.MouseEvent("pointerover", { bubbles: true })));
  assert.ok(trigger() === firstTrigger, "first hover must not replace the menu trigger");
  await act(() => firstTrigger.click());
  await settle();
  assert.ok(menu(), "the first click opens the menu");
  assert.equal(container.contains(menu()), false, "the menu escapes panel stacking and clipping");
  assert.equal(menu()!.querySelectorAll("button").length, 6);
  assert.equal(trigger().getAttribute("aria-expanded"), "true");

  const updated = Array.from(menu()!.querySelectorAll("button")).find((button) => button.textContent === "By updated")!;
  await act(() => updated.click());
  await settle();
  assert.deepEqual(changes, ["recent"]);
  assert.ok(menu() === null, "picking an option dismisses the menu");
  assert.equal(trigger().getAttribute("aria-label"), "Inbox view: By updated");
  assert.ok(document.activeElement === trigger(), "selection restores focus to the trigger");

  await act(() => trigger().click());
  await settle();
  await act(() => document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  assert.ok(menu() === null, "Escape dismisses the menu");

  await act(() => trigger().click());
  await settle();
  await act(() => trigger().click());
  await settle();
  assert.ok(menu() === null, "clicking the trigger again closes without reopening");

  await act(() => trigger().click());
  await settle();
  await act(() => {
    const outside = document.getElementById("outside")!;
    outside.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
    outside.focus();
  });
  await settle();
  assert.ok(menu() === null, "an outside click dismisses the menu");
  assert.deepEqual(changes, ["recent"], "dismissal does not change the view");
  console.log("inbox view menu first interaction, portal, selection and dismissal verified");
} finally {
  await act(() => root.unmount());
  dom.window.close();
}
