import type { CSSProperties } from "react";

// The collapsible caption over an inbox section: its name, its count and the
// chevron. The color rides on the header element itself so simple view can
// tint the divider rule with currentColor; children set their own.
export function SectionHeader({
  label,
  count,
  color,
  sectionKey,
  collapsed,
  monoLabel,
  landedColor,
  onToggle,
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
}) {
  return (
    <button
      data-sv-sec
      data-inbox-section={sectionKey}
      data-inbox-section-count={count}
      onClick={onToggle}
      className={`relative w-full px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between gap-2 ${color}`}
      style={landedColor ? ({ "--hold-dest": landedColor } as CSSProperties) : undefined}
    >
      {landedColor && <span key={landedColor} aria-hidden className="absolute inset-0 pointer-events-none animate-inbox-landed" />}
      {monoLabel ? (
        <span className={`text-[10px] font-semibold flex items-center gap-1.5 min-w-0 ${color}`}>
          <span className="truncate font-mono">{label}</span>
          <span className="opacity-70 shrink-0">({count})</span>
        </span>
      ) : (
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>
          {label} ({count})
        </span>
      )}
      <svg className={`w-3 h-3 transition-transform ${color} ${collapsed ? "" : "rotate-180"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}
