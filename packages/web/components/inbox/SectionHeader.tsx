import type { CSSProperties, ReactNode } from "react";
import type { WorkState } from "@codecast/shared/contracts";
import { ORG_STATE_META } from "../org/orgMeta";

// The states a group header tallies: the two a person acts on or watches.
const HEADER_STATES: WorkState[] = ["needs_input", "working"];

// The collapsible caption over an inbox section: its name, its count and the
// chevron. The color rides on the header element itself so simple view can
// tint the divider rule with currentColor; children set their own. It sticks
// to the top of the list while its section scrolls under it, so the reader
// always knows which section they are in; every style must keep it opaque.
export function SectionHeader({
  label,
  count,
  color,
  sectionKey,
  collapsed,
  monoLabel,
  landedColor,
  onToggle,
  action,
  inRow = false,
  fixed = false,
  icon,
  states,
}: {
  label: string;
  count: number;
  /** A text color class (e.g. "text-sol-magenta"). */
  color: string;
  /** The section's collapse key, also its data-inbox-section. */
  sectionKey: string;
  collapsed: boolean;
  /** A monospace, normal-case, truncating label instead of the uppercased
   *  caption, for long mixed-case identifiers like a plan heading. */
  monoLabel?: boolean;
  /** A row just moved into this collapsed section: wash the header in its color. */
  landedColor?: string;
  onToggle?: () => void;
  /** One text action beside the caption ("Try again" on Couldn't finish).
   *  The header is then a row holding the toggle and the action, since a
   *  button cannot hold another. */
  action?: ReactNode;
  /** Drawn inside an action row, which does the sticking. */
  inRow?: boolean;
  /** A section that never folds (hosted mode's New): no chevron, no toggle. */
  fixed?: boolean;
  /** Drawn before the label (a role's face in "By reports"). */
  icon?: ReactNode;
  /** Work-state tallies over the group's rows, nested ones included. */
  states?: Partial<Record<WorkState, number>>;
}) {
  if (action) {
    return (
      <div data-sv-sec-row className={`sticky top-0 z-10 flex items-center bg-sol-bg ${color}`}>
        <SectionHeader label={label} count={count} color={color} sectionKey={sectionKey} collapsed={collapsed} monoLabel={monoLabel} landedColor={landedColor} onToggle={onToggle} inRow fixed={fixed} icon={icon} states={states} />
        <span className="shrink-0 pr-3 border-b border-sol-border/30 self-stretch flex items-center" data-sv-sec-action>{action}</span>
      </div>
    );
  }
  return (
    <button
      data-sv-sec
      data-inbox-section={sectionKey}
      data-inbox-section-count={count}
      onClick={fixed ? undefined : onToggle}
      tabIndex={fixed ? -1 : undefined}
      data-sv-sec-fixed={fixed || undefined}
      className={`${fixed ? "cursor-default " : ""}${inRow ? "flex-1 min-w-0" : "sticky top-0 z-10 w-full"} px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between gap-2 ${color}`}
      style={landedColor ? ({ "--hold-dest": landedColor } as CSSProperties) : undefined}
    >
      {landedColor && <span key={landedColor} aria-hidden className="absolute inset-0 pointer-events-none animate-inbox-landed" />}
      {monoLabel ? (
        <span className={`text-[10px] font-semibold flex items-center gap-1.5 min-w-0 ${color}`}>
          {icon}
          <span className="truncate font-mono">{label}</span>
          <span className="opacity-70 shrink-0">({count})</span>
        </span>
      ) : (
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>
          {/* Hosted mode (globals.css) drops the brackets and sets the bare
              count in the family's mono. */}
          {label} <span data-cc-sec-count><span data-cc-bracket>(</span>{count}<span data-cc-bracket>)</span></span>
        </span>
      )}
      {states && (
        <span className="ml-auto flex items-center gap-2 shrink-0 font-mono text-[10px] tabular-nums">
          {HEADER_STATES.map((k) => (states[k] ?? 0) > 0 && (
            <span key={k} title={`${states[k]} ${ORG_STATE_META[k].label}`} className="flex items-center gap-1" style={{ color: ORG_STATE_META[k].color }}>
              <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: ORG_STATE_META[k].color }} />
              {states[k]}
            </span>
          ))}
        </span>
      )}
      {!fixed && <svg className={`w-3 h-3 transition-transform ${color} ${collapsed ? "" : "rotate-180"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>}
    </button>
  );
}
