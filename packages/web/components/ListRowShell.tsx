import type { HTMLAttributes, ReactNode } from "react";
import { Check } from "lucide-react";

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
  return (
    <div
      data-list-focused={isFocused || undefined}
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
      <button
        onClick={(e) => { e.stopPropagation(); state.onSelect(); }}
        className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors cq-hide-compact ${
          isSelected
            ? "bg-sol-cyan border-sol-cyan"
            : isFocused
              ? "border-gray-500/50"
              : "border-sol-border/60 opacity-0 group-hover:opacity-100"
        }`}
      >
        {isSelected && <Check className="w-3 h-3 text-sol-bg" />}
      </button>
      {children}
    </div>
  );
}
