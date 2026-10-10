// A scope page's layout (scopes-and-feed.md F4.1): the panel is its own side
// of a seam, an overlay or a phone sheet; closed it renders nothing while the
// conversation stays; the seam's split is the person's one `layouts.org`
// value. The shared live split (stored size, folding, the double-click reset)
// is mounted on the Org screen in OrgScreen.mount.test.tsx.
// Run: bun test components/org/scope/__tests__/ConversationWithPanel.test.tsx
import { test, expect } from "bun:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationWithPanel } from "../ConversationWithPanel";
import { EVEN_SPLIT, seamLayout, splitOf, type SeamSide } from "../seamModel";
import type { PanelLayout } from "../../../../hooks/usePanelLayout";

const render = (layout: PanelLayout, open: boolean, extra: { hide?: SeamSide | null; alone?: boolean } = {}) =>
  renderToStaticMarkup(h(ConversationWithPanel, {
    layout,
    open,
    hide: extra.hide ?? null,
    conversation: extra.alone ? null : h("div", { "data-conv": true }, "talk"),
    panel: h("div", { "data-board": true }, "board"),
  }));
const seams = (html: string) => html.match(/role="separator"/g)?.length ?? 0;

test("each layout wraps the panel its own way and keeps the conversation", () => {
  for (const layout of ["side", "overlay", "sheet"] as const) {
    const html = render(layout, true);
    expect(html).toContain(`data-scope-aside="${layout}"`);
    expect(html).toContain("data-conv");
    expect(html).toContain("data-board");
  }
  expect(render("overlay", true)).toContain("org-panel-in");
  expect(render("sheet", true)).toContain("org-sheet-in");
});

test("beside, the panel is the other side of one seam; overlay and sheet keep the seam hidden", () => {
  const side = render("side", true);
  expect(seams(side)).toBe(1);
  expect(side).toContain('class="cc-split"');
  expect(side).toContain('id="org-left"');
  expect(side).toContain('id="org-right"');
  expect(side).toContain('data-seam="split"');
  for (const layout of ["overlay", "sheet"] as const) {
    const html = render(layout, true);
    expect(html).toContain('class="cc-split is-hidden"');
    expect(html).toContain('data-seam="hide-panel"');
  }
});

test("a closed panel renders nothing, and the conversation stays", () => {
  for (const layout of ["side", "overlay", "sheet"] as const) {
    const html = render(layout, false);
    expect(html).not.toContain("data-scope-aside");
    expect(html).not.toContain("data-board");
    expect(html).toContain("data-conv");
    expect(html).toContain("is-hidden");
  }
});

test("a page showing one side at a time folds the other and hides the seam; no conversation means no seam at all", () => {
  const onMap = render("side", true, { hide: "conversation" });
  expect(onMap).toContain('data-seam="hide-conversation"');
  expect(onMap).toContain("is-hidden");
  expect(onMap).toContain("data-conv");
  const alone = render("side", true, { alone: true });
  expect(seams(alone)).toBe(0);
  expect(alone).toContain("data-board");
});

test("the split: a stored value counts only with room on both sides, and a fold gives one side everything", () => {
  expect(splitOf(undefined)).toEqual(EVEN_SPLIT);
  expect(splitOf({ conversation: 0, company: 100 })).toEqual(EVEN_SPLIT);
  expect(splitOf({ conversation: 64, company: 36 })).toEqual({ conversation: 64, company: 36 });
  expect(seamLayout(null, { conversation: 64, company: 36 })).toEqual({ "org-left": 64, "org-right": 36 });
  expect(seamLayout("panel", EVEN_SPLIT)).toEqual({ "org-left": 100, "org-right": 0 });
  expect(seamLayout("conversation", EVEN_SPLIT)).toEqual({ "org-left": 0, "org-right": 100 });
});
