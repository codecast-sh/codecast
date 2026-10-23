// CopyButton says "Not copied" for a moment when there was nothing to copy
// (a reveal refused by Ask first answers nothing), then goes back to idle,
// and an unmount before the reset leaves no timer behind.
// Run: cd packages/web && bun test components/secrets/CopyButton.mount.test.tsx
import { afterEach, expect, jest, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

async function mountCopy(get: () => string | undefined) {
  jest.useFakeTimers();
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { CopyButton } = await import("./parts");
  const { act } = React;
  const root = createRoot(document.getElementById("root")!);
  act(() => root.render(React.createElement(CopyButton, { get, label: "Copy value" })));
  const button = () => document.querySelector("[data-vault-copy]") as HTMLButtonElement;
  return {
    text: () => button().textContent ?? "",
    press: () => act(async () => button().click()),
    advance: (ms: number) => act(() => { jest.advanceTimersByTime(ms); }),
    unmount: () => {
      act(() => root.unmount());
      closeDomWindow(dom);
    },
  };
}

afterEach(() => {
  jest.useRealTimers();
});

test("a copy with nothing to copy says so, then resets", async () => {
  const m = await mountCopy(() => undefined);
  await m.press();
  expect(m.text()).toBe("Not copied");
  m.advance(1400);
  expect(m.text()).toBe("");
  m.unmount();
});

test("unmounting mid-message clears the reset timer", async () => {
  const m = await mountCopy(() => undefined);
  await m.press();
  expect(jest.getTimerCount()).toBe(1);
  m.unmount();
  expect(jest.getTimerCount()).toBe(0);
});
