// The host half of a pane gesture: a codecast page framed in a pane posts its
// gesture up (postToPaneHost in lib/browserPane), and the pane that frames it
// places the pane on THIS window's stage. The parser is pinned in
// lib/__tests__/browserPane.test.ts; what is pinned here is that the frame
// really listens, and that it hands each message to the gesture it names.

import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import type { BrowserPaneState } from "../browser/backends/types";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const placed: unknown[] = [];
// The two gestures the frame hands its messages to, stood in for. Spread from
// the real modules and handed back in afterAll: a module mock is process-wide
// and outlives this file otherwise, and every later importer of lib/stage
// would get a module missing everything this file did not name.
const realStage = { ...(await import("../../lib/stage")) };
const realOpenIntent = { ...(await import("../../lib/openIntent")) };
afterAll(() => {
  mock.module("../../lib/stage", () => realStage);
  mock.module("../../lib/openIntent", () => realOpenIntent);
});
mock.module("../../lib/stage", () => ({
  ...realStage,
  openBrowserPane: (source: unknown) => {
    placed.push({ pane: source });
    return true;
  },
}));
mock.module("../../lib/openIntent", () => ({
  ...realOpenIntent,
  openIn: (target: string, path: string) => placed.push({ target, path }),
}));

const { FrameBackend } = await import("../browser/backends/FrameBackend");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  // Answered: the pane is showing a page, which is the state a gesture
  // inside it comes from.
  fetch: () => Promise.resolve({}),
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

function send(data: unknown, origin: string, source: unknown) {
  const event = Object.assign(new dom.window.Event("message"), { data, origin, source });
  return act(() => {
    dom.window.dispatchEvent(event);
  });
}

test("a pane gesture from the framed page lands on this window's stage", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <FrameBackend
        source={{ kind: "url", url: "https://codecast.sh/inbox" }}
        focused
        reloadToken={0}
        onTitle={() => {}}
        onUrl={() => {}}
        onState={(_s: BrowserPaneState) => {}}
      />,
    ),
  );
  try {
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const framed = frame.contentWindow;
    expect(framed).toBeTruthy();

    const source = { kind: "url", url: "http://localhost:8765" };
    await send({ type: "codecast:open-pane", source }, "https://codecast.sh", framed);
    await send({ type: "codecast:open-beside", path: "/tasks/ct-1" }, "https://codecast.sh", framed);
    expect(placed).toEqual([{ pane: source }, { target: "split", path: "/tasks/ct-1" }]);

    // Not this pane's frame, and not an app origin: neither reaches the stage.
    await send({ type: "codecast:open-beside", path: "/docs" }, "https://codecast.sh", dom.window);
    await send({ type: "codecast:open-beside", path: "/docs" }, "https://evil.example", framed);
    expect(placed).toHaveLength(2);
  } finally {
    await act(() => root.unmount());
  }
});
