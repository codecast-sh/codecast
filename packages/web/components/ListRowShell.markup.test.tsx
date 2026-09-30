// The list row frame's markup, frozen across its extraction from
// GenericListView (heroFly/ARCHITECTURE.md section 3 item 9). The snapshot was
// written against the row JSX while it lived inline in renderItemRow.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemRowState } from "./ListRowShell";
import { ListRowShell } from "./ListRowShell";

const noop = () => {};
const state = (over: Partial<ItemRowState> = {}): ItemRowState => ({
  isFocused: false, isSelected: false, isEditing: false,
  onClick: noop, onSelect: noop, onContextMenu: noop, onEditDone: noop, onTitleCommit: noop, onOpenPalette: noop,
  ...over,
});

const cases: [string, Record<string, unknown>][] = [
  ["idle", { state: state() }],
  ["focused", { state: state({ isFocused: true }) }],
  ["selected", { state: state({ isSelected: true }) }],
  ["active", { state: state(), isActive: true }],
  ["active and focused", { state: state({ isFocused: true }), isActive: true }],
  ["dragging, draggable", { state: state(), dragging: true, dragProps: { draggable: true, onDragStart: noop } }],
  ["combine target", { state: state(), combineTarget: true }],
  ["group target, gap before", { state: state(), inTargetGroup: true, gapEdge: "before" }],
  ["gap after", { state: state({ isSelected: true, isFocused: true }), gapEdge: "after" }],
];

for (const [name, props] of cases) {
  test(`ListRowShell: ${name}`, () => {
    expect(renderToStaticMarkup(<ListRowShell {...(props as any)}><span>row</span></ListRowShell>)).toMatchSnapshot();
  });
}
