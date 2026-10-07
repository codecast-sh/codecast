// The list row frame's markup, frozen across its extraction from
// GenericListView (heroFly/ARCHITECTURE.md section 3 item 9). The snapshot was
// written against the row JSX while it lived inline in renderItemRow.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemRowState } from "./ListRowShell";
import { ListGroupHeader, ListRowShell } from "./ListRowShell";

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

// The group header's markup as it stood inline in GenericListView's
// renderGroupHeader, kept here as the reference the extracted view must match,
// plus the data hooks hosted mode styles the label and count by (globals.css).
function InlineGroupHeader({ label, count, icon, badge, extra, collapsed, dropTarget }: { label: string; count: number; icon?: React.ReactNode; badge?: React.ReactNode; extra?: React.ReactNode; collapsed: boolean; dropTarget: boolean }) {
  return (
    <div
      className="w-full flex items-center gap-2 px-4 py-2 bg-sol-bg-alt/30 hover:bg-sol-bg-alt/50 border-b border-sol-border/20 transition-colors"
      style={dropTarget ? { boxShadow: "inset 0 0 0 1.5px var(--sol-cyan)" } : undefined}
    >
      <button className="flex items-center gap-2 flex-1 text-left">
        <svg className={`w-3 h-3 text-sol-text-dim transition-transform ${collapsed ? "" : "rotate-90"}`} fill="currentColor" viewBox="0 0 20 20">
          <path d="M6 4l8 6-8 6V4z" />
        </svg>
        {icon}
        <span data-cc-group-label className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">{label}</span>
        <span data-cc-group-count className="text-xs text-sol-text-dim tabular-nums"><span data-cc-bracket>(</span>{count}<span data-cc-bracket>)</span></span>
        {badge}
      </button>
      {extra}
    </div>
  );
}

const headerCases: [string, { label: string; count: number; icon?: React.ReactNode; badge?: React.ReactNode; extra?: React.ReactNode; collapsed: boolean; dropTarget: boolean }][] = [
  ["open", { label: "In Progress", count: 3, collapsed: false, dropTarget: false }],
  ["collapsed, drop target", { label: "Done", count: 12, collapsed: true, dropTarget: true }],
  ["icon, badge, extra", { label: "Todo", count: 2, icon: <i>o</i>, badge: <b>!</b>, extra: <em>+</em>, collapsed: false, dropTarget: false }],
];

for (const [name, props] of headerCases) {
  test(`ListGroupHeader matches the inline header: ${name}`, () => {
    expect(renderToStaticMarkup(<ListGroupHeader {...props} />)).toBe(renderToStaticMarkup(<InlineGroupHeader {...props} />));
  });
}
