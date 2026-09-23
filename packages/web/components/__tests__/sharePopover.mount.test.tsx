import type { Root } from "react-dom/client";
import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// The session header's share popover is the one place to copy a link to the
// session: the page link (signed-in teammates) sits beside the public link
// (anyone). A viewer who cannot manage sharing still gets the page link, and
// none of the controls that would fail for them.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
// Radix (popover, focus scope, dismissable layer) reaches for the DOM's
// element and event classes off the global, so every one jsdom defines is
// installed rather than the handful the render itself touches.
const domClasses = Object.fromEntries(
  Object.getOwnPropertyNames(dom.window)
    .filter((k) => /^(HTML\w*Element|SVG\w*Element|\w*Event|Element|Node|NodeFilter|MutationObserver|DocumentFragment|Text|Range|Selection)$/.test(k))
    .map((k) => [k, (dom.window as any)[k]]),
);
const restoreGlobals = replaceGlobals({
  ...domClasses,
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
// Radix positions the panel with floating-ui, which observes the anchor.
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(dom.window as any).ResizeObserver = (globalThis as any).ResizeObserver;
const { createRoot } = await import("react-dom/client");
const { SharePopover } = await import("../SharePopover");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
});

async function mountOpen(props: Partial<React.ComponentProps<typeof SharePopover>>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(() => root!.render(
    <SharePopover
      hasShareToken={false}
      hasTeam
      teamId="t1"
      onGenerateShareLink={async () => "https://codecast.sh/conversation/c1?share=tok"}
      shareUrl={null}
      pageUrl="https://codecast.sh/conversation/c1"
      forwardLabel="session"
      {...props}
    />,
  ));
  const trigger = container.querySelector("button")!;
  await act(async () => { trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  return document.body.textContent ?? "";
}

test("the owner sees the page link to copy beside the team and public link controls", async () => {
  const text = await mountOpen({});
  expect(text).toContain("Page link");
  expect(document.body.querySelector('input[value="https://codecast.sh/conversation/c1"]')).not.toBeNull();
  expect(text).toContain("Public link");
  expect(text).toContain("Create & copy link");
  expect(text).toContain("Hidden");
});

test("a viewer who cannot manage sharing gets the page link and nothing that would fail", async () => {
  const text = await mountOpen({ canManage: false });
  expect(text).toContain("Page link");
  expect(document.body.querySelector('input[value="https://codecast.sh/conversation/c1"]')).not.toBeNull();
  expect(text).not.toContain("Public link");
  expect(text).not.toContain("Create & copy link");
  expect(text).not.toContain("Hidden");
});
