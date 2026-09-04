import { replaceGlobals } from "../test-helpers/globals";
import { afterAll, test, expect } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";

// Regression: SessionListPanel keeps the current chip filter FUNCTION in state
// so it can re-close the Stashed/Killed buckets when the filter identity
// changes. A function handed straight to a state setter is an UPDATER, so
// React called filterByChip(previousFilter) and threw
// "items.filter is not a function" (prod, 2026-08-26, ErrorBoundary
// SessionList). The setter must go through a thunk. The crash only fires when
// the identity CHANGES, so this test re-renders with a new dep, not once.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});





function Panel({ project }: { project: string }) {
  const filterByChip = useCallback(
    (items: { p: string }[]) => items.filter((x) => x.p === project),
    [project],
  );
  const [bucketsFilter, setBucketsFilter] = useState(() => filterByChip);
  if (bucketsFilter !== filterByChip) setBucketsFilter(() => filterByChip);
  return <span>{bucketsFilter([{ p: "a" }, { p: "b" }, { p: "b" }]).length}</span>;
}

test("re-seeding a function-valued state during render does not invoke it as an updater", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let error: unknown = null;
  const onError = (e: unknown) => { error = e; };

  act(() => root.render(<Panel project="a" />));
  expect(host.textContent).toBe("1");

  // Filter identity changes: the render-time setState must store the new
  // function, not call it with the previous filter as its argument.
  try {
    act(() => root.render(<Panel project="b" />));
  } catch (e) { onError(e); }
  expect(error).toBeNull();
  expect(host.textContent).toBe("2");

  act(() => root.unmount());
  host.remove();
});
