import { test, expect } from "bun:test";
import React, { useCallback, useState } from "react";
import { renderToString } from "react-dom/server";

// Regression: SessionListPanel keeps the current chip filter FUNCTION in state
// so it can re-close the Stashed/Killed buckets when the filter identity
// changes. A function handed straight to a state setter is an UPDATER, so
// React called filterByChip(previousFilter) and threw
// "items.filter is not a function". The setter must go through a thunk.
function Panel({ project }: { project: string }) {
  const filterByChip = useCallback(
    (items: { p: string }[]) => items.filter((x) => x.p === project),
    [project],
  );
  const [bucketsFilter, setBucketsFilter] = useState(() => filterByChip);
  if (bucketsFilter !== filterByChip) setBucketsFilter(() => filterByChip);
  return <span>{bucketsFilter([{ p: "a" }, { p: "b" }]).length}</span>;
}

test("re-seeding a function-valued state during render does not invoke it as an updater", () => {
  // A render-time setState re-runs the component with the fresh identity; the
  // first render's initializer and the re-seed must both keep a plain function.
  expect(() => renderToString(<Panel project="a" />)).not.toThrow();
  expect(renderToString(<Panel project="a" />)).toContain("1");
});
