import type { DragEventHandler, HTMLAttributes, ReactNode } from "react";
import { Check } from "lucide-react";
import { useHostedMode } from "../lib/surfaces";

export interface ItemRowState {
  isFocused: boolean;
  isSelected: boolean;
  isEditing: boolean;
  onClick: () => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditDone: () => void;
  onTitleCommit: (newTitle: string) => void;
  onOpenPalette: (mode: string) => void;
}

/** One list row's frame: focus, selection and drop highlights, the select
 *  checkbox, then the row's own content. GenericListView owns the state and
 *  the drag wiring; this draws it, so any surface can lay out the same row. */
export function ListRowShell({ state, isActive = false, dragging = false, combineTarget = false, inTargetGroup = false, gapEdge = null, dragProps, children }: {
  state: ItemRowState;
  isActive?: boolean;
  /** This row is the one being dragged. */
  dragging?: boolean;
  /** A release here would combine with this row. */
  combineTarget?: boolean;
  /** A release here would move into this row's group. */
  inTargetGroup?: boolean;
  /** A release here would insert on this edge. */
  gapEdge?: "before" | "after" | null;
  dragProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  children: ReactNode;
}) {
  const { isFocused, isSelected } = state;
  // Hosted mode keeps a row's checkbox out of sight until the pointer is on
  // the row or something is selected (x still selects from the keyboard).
  const hosted = useHostedMode();
  return (
    <div
      data-list-focused={isFocused || undefined}
      // The row's selection state for the hosted token layer (globals.css),
      // which draws it in the family's accent rather than the developer cyan.
      data-list-row-state={isActive ? "active" : isFocused ? "focused" : isSelected ? "selected" : undefined}
      onClick={state.onClick}
      onContextMenu={state.onContextMenu}
      {...dragProps}
      style={
        combineTarget
          ? { boxShadow: "inset 0 0 0 1.5px var(--sol-cyan)" }
          : inTargetGroup
            ? { background: "color-mix(in srgb, var(--sol-cyan) 6%, transparent)" }
            : undefined
      }
      className={`relative w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left group border-b border-sol-border/20 cursor-pointer select-none ${
        dragging ? "opacity-40" : ""
      } ${
        isActive && isFocused
          ? "bg-sol-cyan/15 border-l-[3px] border-l-sol-cyan"
          : isActive
            ? "bg-sol-yellow/8 border-l-[3px] border-l-sol-yellow"
            : isFocused
              ? "bg-sol-cyan/10 border-l-[3px] border-l-sol-cyan"
              : isSelected
                ? "bg-sol-cyan/8 border-l-[3px] border-l-sol-cyan/50"
                : "hover:bg-sol-bg-alt/50 border-l-[3px] border-l-transparent"
      }`}
    >
      {gapEdge && (
        <span
          aria-hidden
          className={`pointer-events-none absolute left-2 right-2 h-0.5 rounded bg-sol-cyan z-10 ${
            gapEdge === "before" ? "top-[-1px]" : "bottom-[-1px]"
          }`}
        />
      )}
      {/* Bulk select is a developer's gesture: hosted mode draws the box only
          on a selected row, so titles line up under the page's heading
          instead of after an empty gutter. */}
      {(!hosted || isSelected) && <button
        onClick={(e) => { e.stopPropagation(); state.onSelect(); }}
        className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors cq-hide-compact ${
          isSelected
            ? "bg-sol-cyan border-sol-cyan"
            : isFocused && !hosted
              ? "border-gray-500/50"
              : "border-sol-border/60 opacity-0 group-hover:opacity-100"
        }`}
      >
        {isSelected && <Check className="w-3 h-3 text-sol-bg" />}
      </button>}
      {children}
    </div>
  );
}

/** A list group's header: the fold chevron, label and count, then the
 *  group's own extras. GenericListView owns folding and drop hints; this draws
 *  them. */
export function ListGroupHeader({ label, count, icon, badge, extra, collapsed, onToggle, dropTarget = false, onDragOver, onDrop }: {
  label: ReactNode;
  count: number;
  icon?: ReactNode;
  badge?: ReactNode;
  extra?: ReactNode;
  collapsed: boolean;
  onToggle?: () => void;
  /** A release here would move into this group. */
  dropTarget?: boolean;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      className="w-full flex items-center gap-2 px-4 py-2 bg-sol-bg-alt/30 hover:bg-sol-bg-alt/50 border-b border-sol-border/20 transition-colors"
      style={dropTarget ? { boxShadow: "inset 0 0 0 1.5px var(--sol-cyan)" } : undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        onClick={onToggle}
        className="flex items-center gap-2 flex-1 text-left"
      >
        <svg
          className={`w-3 h-3 text-sol-text-dim transition-transform ${collapsed ? "" : "rotate-90"}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M6 4l8 6-8 6V4z" />
        </svg>
        {icon}
        <span data-cc-group-label className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">
          {label}
        </span>
        {/* Hosted mode (globals.css) drops the brackets and sets the bare
            count in the family's mono, as Whisk counts a list. */}
        <span data-cc-group-count className="text-xs text-sol-text-dim tabular-nums"><span data-cc-bracket>(</span>{count}<span data-cc-bracket>)</span></span>
        {badge}
      </button>
      {extra}
    </div>
  );
}
