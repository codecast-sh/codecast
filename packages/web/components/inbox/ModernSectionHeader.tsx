import type { CSSProperties, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { WorkState } from "@codecast/shared/contracts";
import { SECTION_HEADER_STATUS, type SessionStatus } from "../../lib/sessionStatus";
import { SessionStatusMark } from "./SessionStatusMark";

// The rail's section header in the Modern style: one quiet look for every
// section (All, Needs you, Working, Done, Dormant, a label, a plan, a role):
// the state's mark when the section is a state, an 11px capital label, the
// count, then a hairline to the edge. Sticky and opaque, 32px tall (the rows'
// scroll margin assumes it), with the data attributes SectionHeader carries.

// What a role group's tallies count (SectionHeader's HEADER_STATES), in the
// status vocabulary's marks.
const TALLY: Array<[WorkState, SessionStatus]> = [["needs_input", "needs_you"], ["working", "working"]];

export function ModernSectionHeader({
  label,
  count,
  color,
  sectionKey,
  collapsed,
  monoLabel,
  landedColor,
  onToggle,
  action,
  icon,
  states,
}: {
  label: string;
  count: number;
  color: string;
  sectionKey: string;
  collapsed: boolean;
  monoLabel?: boolean;
  landedColor?: string;
  onToggle?: () => void;
  action?: ReactNode;
  icon?: ReactNode;
  states?: Partial<Record<WorkState, number>>;
}) {
  const status = SECTION_HEADER_STATUS[sectionKey];
  // A section that is not a state (a label, a project, Pinned) keeps its own
  // colour as a dot, so a label still reads as that label.
  const lead = icon ?? (status ? <SessionStatusMark status={status} /> : <span aria-hidden className={`flex ${color}`}><span className="h-1.5 w-1.5 rounded-full bg-current" /></span>);
  const chevron = <ChevronDown aria-hidden className={`h-3.5 w-3.5 shrink-0 text-sol-text-dim transition-transform ${collapsed ? "-rotate-90" : ""}`} />;
  const caption = (
    <>
      <span className="flex shrink-0 items-center">{lead}</span>
      <span className={monoLabel ? "min-w-0 truncate font-mono text-meta font-medium text-sol-text-muted" : "min-w-0 truncate text-mark font-semibold uppercase tracking-[0.08em] text-sol-text-muted"}>
        {label}
      </span>
      <span className="shrink-0 text-mark tabular-nums text-sol-text-dim">{count}</span>
      {states && TALLY.map(([k, s]) => (states[k] ?? 0) > 0 && (
        <span key={k} title={`${states[k]} ${k === "needs_input" ? "need you" : "working"}`} className="flex shrink-0 items-center gap-1 text-mark tabular-nums text-sol-text-dim">
          <SessionStatusMark status={s} size={8} />
          {states[k]}
        </span>
      ))}
      <span aria-hidden className="h-px min-w-4 flex-1 bg-sol-border" />
    </>
  );
  return (
    <div
      data-mc-sec
      className="sticky top-0 z-10 mt-1.5 flex h-8 items-center gap-2 bg-sol-bg-alt pl-3 pr-2"
      style={landedColor ? ({ "--hold-dest": landedColor } as CSSProperties) : undefined}
    >
      {landedColor && <span key={landedColor} aria-hidden className="pointer-events-none absolute inset-0 animate-inbox-landed" />}
      <button
        type="button"
        data-inbox-section={sectionKey}
        data-inbox-section-count={count}
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]"
      >
        {caption}
        {!action && chevron}
      </button>
      {action && <span data-sv-sec-action className="flex shrink-0 items-center">{action}</span>}
      {action && (
        <button type="button" aria-label={collapsed ? `Show ${label}` : `Hide ${label}`} onClick={onToggle} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control">
          {chevron}
        </button>
      )}
    </div>
  );
}
