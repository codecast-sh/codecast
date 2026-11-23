import { replaceGlobals } from "../test-helpers/globals";
import { afterAll, test, expect } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { closeDomWindow } from "../test-helpers/domGlobals";
import { useHiddenBucketsOpen } from "../hooks/useHiddenBucketsOpen";

// Regression: the sidebar's Stashed bucket shut itself every few seconds while
// someone was reading it. The reset was keyed on the chip filter callback's
// identity, which turns over on every placement tick. It is keyed on the
// filter's value now: a re-render with the same filter keeps an open bucket
// open, and a filter change closes it.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

let openStashed: () => void = () => {};

function Buckets({ project, tick }: { project: string; tick: number }) {
  // A fresh array every render, like the panel's filter terms.
  const [open, setOpen] = useHiddenBucketsOpen(JSON.stringify([[{ id: project }], []]));
  openStashed = () => setOpen((o) => ({ ...o, stashed: true }));
  return <span data-tick={tick}>{open.stashed ? "open" : "closed"}</span>;
}

test("an open bucket stays open across re-renders and closes when the filter changes", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => root.render(<Buckets project="a" tick={0} />));
  expect(host.textContent).toBe("closed");

  act(() => openStashed());
  expect(host.textContent).toBe("open");

  // Placement ticks: same filter value, new objects each render.
  for (let tick = 1; tick <= 3; tick++) {
    act(() => root.render(<Buckets project="a" tick={tick} />));
    expect(host.textContent).toBe("open");
  }

  act(() => root.render(<Buckets project="b" tick={4} />));
  expect(host.textContent).toBe("closed");

  act(() => root.unmount());
  host.remove();
});
