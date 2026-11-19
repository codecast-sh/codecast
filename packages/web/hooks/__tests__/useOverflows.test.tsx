// The clamp a long body starts with must be in the DOM before the first
// paint, with no help from a ResizeObserver callback: a state set from that
// callback renders after paint, so a transcript row painted at full height,
// the virtualizer measured it, then it clamped, and near the tail of a
// conversation the swing remounted rows in a loop that shook the view.
// The observer here never answers, so only the commit's own first answer can
// clamp the body.
import { test, expect, afterAll } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(dom.window.Element.prototype, "scrollHeight", { configurable: true, get() { return Math.ceil(((this as Element).textContent?.length ?? 0) / 90) * 20; } });
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { CollapsibleBody } = await import("../../components/CollapsibleBody");

test("a long body is clamped by the end of its mount commit, without an observer callback", async () => {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(React.createElement(CollapsibleBody, null, "x".repeat(90 * 30))); });
  const clip = document.querySelector("[data-collapsible-body]")!.parentElement as HTMLElement;
  expect(clip.style.maxHeight).toBe("180px");
  expect(document.body.textContent).toContain("Expand");
  await act(async () => root.unmount());
});

test("a short body stays open", async () => {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(React.createElement(CollapsibleBody, null, "short")); });
  const clip = document.querySelector("[data-collapsible-body]")!.parentElement as HTMLElement;
  expect(clip.style.maxHeight).toBe("");
  await act(async () => root.unmount());
});
