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
  hidden = false,
  size = "row",
}: {
  days: readonly string[];
  counts: readonly number[] | undefined;
  /** Cutoffs shared across the page (stripLevels); left out, the strip's own. */
  levels?: number[];
  muted?: boolean;
  /** The owner hid their activity: the days show, none shaded. */
  hidden?: boolean;
  /** row: a priority's row; step: a step's or a session's line, shorter. */
  size?: "row" | "step";
}) {
  const cells = stripCells(days, hidden ? undefined : counts);
  const cuts = levels ?? heatLevels(cells.map((c) => c.count));
  const colors = muted || hidden ? GREY : HEAT_COLORS;
  return (
    <span
      data-history-strip
      data-hidden={hidden || undefined}
      title={hidden ? "Activity hidden" : undefined}
      className="grid gap-[3px]"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))` }}
    >
      {cells.map((c) => (
        <i
          key={c.day}
          title={hidden ? undefined : c.title}
          className={size === "row" ? "block h-3.5 rounded-[3px]" : "block h-2 rounded-[2px]"}
          style={{ background: heatColor(c.count, cuts, colors) }}
        />
      ))}
    </span>
  );
}
