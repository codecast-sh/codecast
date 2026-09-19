// The layout a scope and an initiative share (scopes-and-feed.md F4.1): the
// panel is a column, an overlay or a phone sheet, and closed it renders nothing
// while the conversation stays.
// Run: bun test components/org/scope/__tests__/ConversationWithPanel.test.tsx
import { test, expect } from "bun:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationWithPanel, PANEL_W, type PanelLayout } from "../ConversationWithPanel";

const render = (layout: PanelLayout, open: boolean) =>
  renderToStaticMarkup(h(ConversationWithPanel, { layout, open, conversation: h("div", { "data-conv": true }, "talk"), panel: h("div", { "data-panel": true }, "board") }));

test("each layout wraps the panel its own way and keeps the conversation", () => {
  for (const layout of ["side", "overlay", "sheet"] as const) {
    const html = render(layout, true);
    expect(html).toContain(`data-scope-aside="${layout}"`);
    expect(html).toContain("data-conv");
    expect(html).toContain("data-panel");
  }
  expect(render("side", true)).toContain(`width:${PANEL_W}px`);
  expect(render("overlay", true)).toContain("org-panel-in");
  expect(render("sheet", true)).toContain("org-sheet-in");
});

test("a closed panel renders nothing, and the conversation stays", () => {
  for (const layout of ["side", "overlay", "sheet"] as const) {
    const html = render(layout, false);
    expect(html).not.toContain("data-scope-aside");
    expect(html).not.toContain("data-panel");
    expect(html).toContain("data-conv");
  }
});
