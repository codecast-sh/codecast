import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// Your own screen share shows on the stage as a placeholder, never as its
// video: the picture of a screen drawn back onto that screen is a mirror.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
const { createRoot } = await import("react-dom/client");
const { GridStage } = await import("../StageViews");
const { StageHostProvider } = await import("../stageHost");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const attached: string[] = [];
const trackFor = (key: string) => ({ sid: key, attach() { attached.push(key); }, detach() {}, on() {}, off() {} }) as any;
const screen = (identity: string, isLocal: boolean) =>
  ({ key: `${identity}:screen`, identity, name: identity, kind: "screen", track: trackFor(`${identity}:screen`), isLocal }) as any;

test("my share draws a placeholder and never attaches; a teammate's share draws its video", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <StageHostProvider value={{ getRoom: () => null }}>
        <GridStage roster={[]} cameras={[]} screens={[screen("u-sam", false), screen("u-me", true)]} speaking={new Set()} />
      </StageHostProvider>,
    ),
  );
  expect(attached).toEqual(["u-sam:screen"]);
  expect(container.querySelectorAll("video").length).toBe(1);
  expect(container.querySelector("[data-own-screen]")?.textContent).toContain("your screen is live");
  await act(() => root.unmount());
});
