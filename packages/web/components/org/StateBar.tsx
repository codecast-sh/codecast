// The state bar and tally every org surface draws under a parent: the cards,
// the goals map, the scope board and the company page.
import { cn } from "../../lib/utils";
import { ORG_STATE_ORDER, type StateCounts } from "./orgTypes";
import { ORG_STATE_META } from "./orgMeta";

/** Five proportional segments in state order; an empty parent draws a hairline. */
export function StateBar({ counts, className }: { counts: StateCounts; className?: string }) {
  const total = ORG_STATE_ORDER.reduce((n, k) => n + (counts[k] ?? 0), 0);
  return (
    <div className={cn("flex h-[5px] w-full gap-[2px] rounded-full overflow-hidden", className)} aria-hidden>
      {total === 0 ? (
        <div className="flex-1 rounded-full" style={{ background: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }} />
      ) : (
        ORG_STATE_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => (
          <div
            key={k}
            className="rounded-full"
            style={{ flex: counts[k], background: ORG_STATE_META[k].color, opacity: k === "idle" ? 0.45 : 0.9 }}
            title={`${counts[k]} ${ORG_STATE_META[k].label}`}
          />
        ))
      )}
    </div>
  );
}

/**
 * The state tally. With `labels` each count carries its word ("231 needs
 * input · 2 working"): the form for the one place per surface that teaches
 * the colours (the org header, the scope board line). Without, dots only, for
 * a cluster card sitting under its parent's StateBar; zero counts are then
 * dropped rather than faded, so nothing is drawn that cannot be read.
 */
export function StateTally({ counts, dim, labels }: { counts: StateCounts; dim?: boolean; labels?: boolean }) {
  const shown = labels ? ORG_STATE_ORDER : ORG_STATE_ORDER.filter((k) => (counts[k] ?? 0) > 0);
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums text-[10.5px] font-medium whitespace-nowrap">
      {shown.map((k) => (
        <span key={k} className="inline-flex items-center gap-[3px]" title={ORG_STATE_META[k].label}>
          <span className="w-[6px] h-[6px] rounded-full" style={{ background: ORG_STATE_META[k].color, opacity: (counts[k] ?? 0) === 0 ? 0.3 : 1 }} />
          <span style={{ color: (counts[k] ?? 0) === 0 || dim ? "var(--sol-text-dim)" : "var(--sol-text-secondary)" }}>{counts[k] ?? 0}</span>
          {labels && <span className="font-normal" style={{ color: (counts[k] ?? 0) === 0 ? "var(--sol-text-dim)" : "var(--sol-text-muted)" }}>{ORG_STATE_META[k].label}</span>}
        </span>
      ))}
      {shown.length === 0 && <span style={{ color: "var(--sol-text-dim)" }}>none</span>}
    </span>
  );
}
