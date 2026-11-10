// useNowWhen rides the shared coarse clock: a list of N rows checks its
// signatures on one timer instead of N unaligned intervals, and a row still
// re-renders when (and only when) its signature crosses a threshold.

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { useNowWhen } = await import("../useCoarseNow");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const INTERVAL = 25;
const realSetInterval = globalThis.setInterval;

test("N rows share one timer and re-render only on a threshold crossing", async () => {
  let intervals = 0;
  (globalThis as any).setInterval = ((fn: () => void, ms?: number) => {
    if (ms === INTERVAL) intervals++;
    return realSetInterval(fn, ms);
  }) as typeof setInterval;
  const start = Date.now();
  const renders = [0, 0, 0, 0, 0];
  function Row({ i }: { i: number }) {
    renders[i]++;
    // Row 0 crosses its threshold after 60ms; the others never do.
    useNowWhen((now) => (i === 0 && now - start > 60 ? "late" : "early"), INTERVAL);
    return null;
  }
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<>{renders.map((_, i) => <Row key={i} i={i} />)}</>); });
    expect(intervals).toBe(1);
    await act(async () => { await new Promise((r) => setTimeout(r, 160)); });
    expect(renders[0]).toBe(2);
    expect(renders.slice(1)).toEqual([1, 1, 1, 1]);
  } finally {
    await act(async () => { root.unmount(); });
    (globalThis as any).setInterval = realSetInterval;
  }
});
