// A priority's (or a step's) last days of attention: one cell per local day,
// shaded by how many messages the person typed into its sessions that day,
// on the activity charts' own heat ramp.
import { HEAT_COLORS, heatColor, heatLevels, heatRamp } from "../ActivityHeatmap";
import { stripCells } from "../../lib/priorities";

/** A quiet or set-aside priority's strip: the same cells in grey. */
const GREY = heatRamp("--sol-text-muted");

export function HistoryStrip({
  days,
  counts,
  levels,
  muted = false,
  truncated = false,
  size = "row",
}: {
  days: readonly string[];
  counts: readonly number[] | undefined;
  /** Cutoffs shared across the page (stripLevels); left out, the strip's own. */
  levels?: number[];
  muted?: boolean;
  /** The read stopped at its cap: the oldest days may be short. Marked on the oldest cell, said in the tooltip. */
  truncated?: boolean;
  /** row: a priority's row; step: a step's or a session's line, shorter. */
  size?: "row" | "step";
}) {
  const cells = stripCells(days, counts);
  const cuts = levels ?? heatLevels(cells.map((c) => c.count));
  const colors = muted ? GREY : HEAT_COLORS;
  return (
    <span
      data-history-strip
      data-truncated={truncated || undefined}
      title={truncated ? "Older activity not counted" : undefined}
      className="grid gap-[3px]"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))` }}
    >
      {cells.map((c, i) => (
        <i
          key={c.day}
          title={c.title}
          className={`${size === "row" ? "block h-3.5 rounded-[3px]" : "block h-2 rounded-[2px]"}${truncated && i === 0 ? " outline-dashed outline-1 -outline-offset-1 outline-sol-text-dim/60" : ""}`}
          style={{ background: heatColor(c.count, cuts, colors) }}
        />
      ))}
    </span>
  );
}
