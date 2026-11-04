// The month's usage as a meter: the bar Settings > Plan leads with. Every
// figure comes from the wallet (usePlanMeter).
import { cn } from "@/lib/utils";
import { LANE_COPY } from "../simple/lane";

/** The bar: what is used, then what is set aside for work in progress. */
export function MeterBar({ fill, full, known, cap, used, className, minUsedPx, label }: {
  fill: { used: number; held: number };
  full: boolean;
  known: boolean;
  cap: number;
  used: number;
  className?: string;
  /** The least width the used part draws once anything is used, so a thin
   *  bar early in the month still shows that it has started. */
  minUsedPx?: number;
  /** What the meter measures, for assistive tech; the plan's allowance by default. */
  label?: string;
}) {
  return (
    <div
      role="meter"
      aria-label={label ?? LANE_COPY.plan.meterLabel}
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={Math.min(used, cap)}
      // Read as a share, never as the raw figure behind it.
      aria-valuetext={known ? `${Math.round(Math.min(fill.used, 1) * 100)}% used` : undefined}
      data-cc-meter
      data-cc-meter-high={known && fill.used >= 0.8 ? "" : undefined}
      data-cc-meter-full={known && full ? "" : undefined}
      className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-sol-bg-highlight", className)}
    >
      <div data-cc-meter-used className={cn("h-full transition-[width] duration-500 ease-out", full ? "bg-sol-orange" : "bg-sol-cyan")} style={{ width: `${known ? fill.used * 100 : 0}%`, minWidth: known && fill.used > 0 ? minUsedPx : undefined }} />
      <div data-cc-meter-held title="Set aside for work still running; it comes back when that work ends" className="h-full bg-sol-cyan/35 transition-[width] duration-500 ease-out" style={{ width: `${known ? fill.held * 100 : 0}%` }} />
    </div>
  );
}
