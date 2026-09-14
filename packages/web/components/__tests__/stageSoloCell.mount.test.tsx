import { afterAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { besideLeafId, seedLeafId } from "../../store/stageSplit";
import { openBeside, stageRenderLayout } from "../../lib/stage";
import StageSplitView from "../stage/StageSplitView";

// A plain tab renders through the flat stage as one solo cell, and the first
// split keeps that cell: the page in it is never remounted. Pinned at the DOM
// — the cell element and the wrapper the page renders into must be the SAME
// nodes before and after an Option-click opens a pane beside them.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400 }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});

const tab = (): AppTab => ({ id: "t1", title: "A", path: "/nowhere", createdAt: 0 });
const activeTab = () => useInboxStore.getState().tabs.find((t) => t.id === "t1")!;

beforeEach(() => {
  useInboxStore.setState({ tabs: [tab()], activeTabId: "t1" } as any);
});

function Stage() {
  const t = useInboxStore((s) => s.tabs.find((x) => x.id === "t1")!);
  return <StageSplitView tab={t} layout={stageRenderLayout(t, false)} isTabActive />;
}

test("the first split keeps the origin cell and the page inside it", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() => root.render(<Stage />));
    const cells = () => Array.from(container.querySelectorAll("[data-stage-leaf]")) as HTMLElement[];
    expect(cells().map((c) => c.dataset.stageLeaf)).toEqual([seedLeafId("t1")]);
    const origin = cells()[0];
    // Solo: no strip, no focus ring, the whole stage.
    expect(origin.className).toBe("stage-cell");
    expect(origin.style.width).toBe("100%");
    const pageSlot = origin.querySelector(".flex-1") as HTMLElement;
    expect(pageSlot).not.toBeNull();
    expect(origin.querySelector("[draggable]")).toBeNull();

    await act(() => { openBeside("/elsewhere", { reuse: true }); });

    expect(cells().map((c) => c.dataset.stageLeaf)).toEqual([seedLeafId("t1"), besideLeafId("t1")]);
    // Same element, same page wrapper: nothing remounted.
    expect(cells()[0]).toBe(origin);
    expect(origin.querySelector(".flex-1")).toBe(pageSlot);
    // The cell became a split pane: it got its strip, it kept focus.
    expect(origin.querySelector("[draggable]")).not.toBeNull();
    expect(origin.className).toBe("stage-cell stage-cell--focused");
    expect(activeTab().path).toBe("/nowhere");

    // A second Option-click re-points the target pane; still the same origin.
    await act(() => { openBeside("/third", { reuse: true }); });
    expect(cells().length).toBe(2);
    expect(cells()[0]).toBe(origin);
    expect(origin.querySelector(".flex-1")).toBe(pageSlot);
    expect(activeTab().layout && (activeTab().layout as any).children[1].path).toBe("/third");
  } finally {
    await act(() => root.unmount());
  }
});
