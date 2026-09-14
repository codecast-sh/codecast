import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { CtxSeparator } from "../../components/ui/context-menu";
import { browserPaneMenuItems } from "../browserPaneMenuItems";

// Both web address pills (a dev server URL in a transcript, the tab a
// `cast browser` row drove) read their menu from this one helper. The rows are
// read off the element tree rather than a rendered menu: a Radix item only
// renders inside an open menu, and what drifts between two copies is exactly
// this, the rows and their words.
function rows(node: ReactNode): string[] {
  const fragment = node as ReactElement<{ children: ReactNode[] }>;
  return fragment.props.children.filter(isValidElement).map((row) =>
    row.type === CtxSeparator ? "---" : String((row.props as { children: ReactNode }).children),
  );
}

describe("browserPaneMenuItems", () => {
  test("offers the same four verbs on any address", () => {
    expect(rows(browserPaneMenuItems("http://localhost:3000/"))).toEqual([
      "Open in a pane",
      "Open in a pane, full width",
      "Open in a browser tab",
      "---",
      "Copy address",
    ]);
  });

  test("renames only the pane row, for the page an agent drove", () => {
    expect(
      rows(browserPaneMenuItems("https://example.com/", { paneLabel: "Preview this page in a pane" })),
    ).toEqual([
      "Preview this page in a pane",
      "Open in a pane, full width",
      "Open in a browser tab",
      "---",
      "Copy address",
    ]);
  });
});
