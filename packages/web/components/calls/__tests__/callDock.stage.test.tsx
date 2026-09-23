// THE STAGE OPENS ONLY ON AN EXPLICIT EXPAND (pl-756 F3).
//
// The corner used to hold four shapes and morph between them; the face row in
// the header is every small call surface now, and the dock keeps the one shape
// the row cannot be: the full stage. What is pinned here is the gate: the stage
// is not there while a call runs, it appears when the person opens it, it goes
// when they collapse it or the call ends, and the next call does not inherit
// an open stage from the last one.
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// The stage itself is a marker: the gate is under test, not the stage.
const realStage = await import("../CallStage");
mock.module("../CallStage", () => ({
  ...realStage,
  CallStage: ({ onCollapse }: { onCollapse?: () => void }) => (
    <button type="button" data-stage onClick={onCollapse}>
      stage
    </button>
  ),
}));
// The desktop handoff would read the shell; a browser has none.
const realHandoff = await import("../../../hooks/useHandCallToPanel");
mock.module("../../../hooks/useHandCallToPanel", () => ({ ...realHandoff, useHandCallToPanel: () => {} }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { CallDock } = await import("../CallDock");
const { openCallStage, closeCallStage, getCallStageOpen } = await import("../../../lib/calls/callStage");

afterAll(() => {
  mock.module("../CallStage", () => realStage);
  mock.module("../../../hooks/useHandCallToPanel", () => realHandoff);
  closeDomWindow(dom);
  restoreGlobals();
});

let root: Root | null = null;
let host: HTMLElement | null = null;

function setPhase(phase: string) {
  useInboxStore.setState({ call: { ...useInboxStore.getState().call, phase, roomKey: phase === "idle" ? null : "dm:a:b" } } as any);
}

beforeEach(() => {
  closeCallStage();
  setPhase("idle");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mount() {
  host = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(<CallDock />));
  return {
    stage: () => host!.querySelector("[data-stage]") as HTMLElement | null,
    click: async (el: Element) => {
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

describe("the stage is a door the person opens", () => {
  test("a call running does not open it; Open the call does; collapse closes it", async () => {
    const h = await mount();
    await act(async () => setPhase("connected"));
    expect(h.stage()).toBeNull();
    await act(async () => openCallStage());
    expect(h.stage()).not.toBeNull();
    await h.click(h.stage()!);
    expect(h.stage()).toBeNull();
    expect(getCallStageOpen()).toBe(false);
  });

  test("the call ending closes it, and the next call does not inherit it", async () => {
    const h = await mount();
    await act(async () => setPhase("connected"));
    await act(async () => openCallStage());
    expect(h.stage()).not.toBeNull();
    await act(async () => setPhase("idle"));
    expect(h.stage()).toBeNull();
    expect(getCallStageOpen()).toBe(false);
    await act(async () => setPhase("connected"));
    expect(h.stage()).toBeNull();
  });

  test("opened with no call there is nothing to show", async () => {
    const h = await mount();
    await act(async () => openCallStage());
    expect(h.stage()).toBeNull();
  });
});
