import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// A right click on anyone in the call opens the host's menu for them, from a
// face tile or a voice row alike, and never for the viewer's own tile.

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
});
const { createRoot } = await import("react-dom/client");
const { GridStage } = await import("../StageViews");
const { StageHostProvider } = await import("../stageHost");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const track = { attach() {}, detach() {}, on() {}, off() {} } as any;
const tile = (identity: string, name: string, isLocal = false) => ({ key: `${identity}:camera`, identity, name, kind: "camera", track, isLocal }) as any;

test("right click on an agent's face, a teammate's row or a guest's opens their menu; my own tile does not", async () => {
  const opened: string[] = [];
  const host = { getRoom: () => null, openPersonMenu: (e: any, p: { identity: string }) => (e.preventDefault(), opened.push(p.identity)) };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <StageHostProvider value={host}>
        <GridStage
          roster={[{ user_id: "u-sam", user_name: "Sam Lee" }, { user_id: "guest:g1", user_name: "Ada Lovelace" }]}
          cameras={[tile("agent:conv1", "Flicker"), tile("u-me", "Me", true)]}
          screens={[]}
          speaking={new Set()}
        />
      </StageHostProvider>,
    ),
  );
  const rightClick = (el: Element) => el.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const videos = container.querySelectorAll("video");
  rightClick(videos[0]);
  rightClick(videos[1]);
  const named = (text: string) => [...container.querySelectorAll("span")].filter((s) => s.textContent?.includes(text)).pop()!;
  rightClick(named("Sam"));
  rightClick(named("Ada"));
  expect(opened).toEqual(["agent:conv1", "u-sam", "guest:g1"]);
  await act(() => root.unmount());
});
