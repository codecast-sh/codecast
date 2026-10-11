// The month's usage as a meter: the bar Settings > Plan leads with, and the
// quiet copy of it at the foot of the sidebar in hosted mode, which opens the
// plan settings. Every figure comes from the wallet (usePlanMeter).
import { cn } from "@/lib/utils";
import { useHostedMode } from "../../lib/surfaces";
import { useInboxStore } from "../../store/inboxStore";
import { LANE_COPY, meterShort, meterWords } from "../simple/lane";
import { usePlanMeter } from "../simple/usePlanFigures";

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

function ShellUsageMeterBody() {
  // The host window feeds the wallet (DashboardLayout HostFeeders) and the
  // rest read what it replicates, so this only reads.
  const { known, figures, fill, full } = usePlanMeter(false);
  // An empty track reads as nothing used, or broken: the meter waits for its
  // figure.
  if (!known) return null;
  // While the allowance has room the words count what is left in requests;
  // the share used is the tooltip, and Settings > Plan says it in full.
  const words = meterWords(figures);
  return (
    <button
      type="button"
      data-cc-usage-meter
      // The button's name is its words; the bar inside would add its value.
      aria-label={words}
      onClick={() => useInboxStore.getState().openSettingsModal("plan")}
      title={`${meterShort(figures)}. ${LANE_COPY.plan.title}`}
      className="mx-3 mt-2 flex flex-col gap-1.5 rounded-md px-2 py-2 text-left text-[11px] text-sol-text-dim transition-colors hover:bg-sol-bg-highlight/50 hover:text-sol-text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-cyan/50"
    >
      <span className="truncate whitespace-nowrap tabular-nums">
        {words}
      </span>
      <MeterBar fill={fill} full={full} known={known} cap={figures.cap_usd} used={figures.used_usd} className="h-[3px]" minUsedPx={4} />
    </button>
  );
}

/** The sidebar's usage meter: only in hosted mode, where the assistant's
 *  work is what the person pays for. The wallet feeder mounts only then. */
export function ShellUsageMeter() {
  return useHostedMode() ? <ShellUsageMeterBody /> : null;
}
