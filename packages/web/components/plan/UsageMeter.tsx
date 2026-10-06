// The month's usage as a meter: the bar Settings > Plan leads with, and the
// quiet copy of it at the foot of the sidebar in hosted mode, which opens the
// plan settings. Every figure comes from the wallet (usePlanMeter).
import { cn } from "@/lib/utils";
import { useHostedMode } from "../../lib/surfaces";
import { useIsSyncHost } from "../../hooks/useSyncRole";
import { useInboxStore } from "../../store/inboxStore";
import { LANE_COPY, dollars } from "../simple/lane";
import { usePlanMeter } from "../simple/usePlanFigures";

/** The bar: what is used, then what is set aside for work in progress. */
export function MeterBar({ fill, full, known, cap, used, className }: {
  fill: { used: number; held: number };
  full: boolean;
  known: boolean;
  cap: number;
  used: number;
  className?: string;
}) {
  return (
    <div
      role="meter"
      aria-label={LANE_COPY.plan.meterLabel}
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={Math.min(used, cap)}
      className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-sol-bg-highlight", className)}
    >
      <div className={cn("h-full transition-[width] duration-500 ease-out", full ? "bg-sol-orange" : "bg-sol-cyan")} style={{ width: `${known ? fill.used * 100 : 0}%` }} />
      <div className="h-full bg-sol-cyan/35 transition-[width] duration-500 ease-out" style={{ width: `${known ? fill.held * 100 : 0}%` }} />
    </div>
  );
}

function ShellUsageMeterBody() {
  // Always mounted, so it feeds only in the sync host window (useWallet).
  const { known, figures, fill, full } = usePlanMeter(useIsSyncHost());
  return (
    <button
      type="button"
      data-cc-usage-meter
      onClick={() => useInboxStore.getState().openSettingsModal("plan")}
      title={LANE_COPY.plan.title}
      className="mx-3 mt-2 flex flex-col gap-1.5 rounded-md px-2 py-2 text-left text-[11px] text-sol-text-dim transition-colors hover:bg-sol-bg-highlight/50 hover:text-sol-text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-cyan/50"
    >
      <span className="truncate whitespace-nowrap tabular-nums">
        {known ? `${dollars(figures.used_usd)} of ${dollars(figures.cap_usd)} ${LANE_COPY.plan.thisMonth.toLowerCase()}` : LANE_COPY.plan.thisMonth}
      </span>
      <MeterBar fill={fill} full={full} known={known} cap={figures.cap_usd} used={figures.used_usd} className="h-1" />
    </button>
  );
}

/** The sidebar's usage meter: only in hosted mode, where the assistant's
 *  work is what the person pays for. The wallet feeder mounts only then. */
export function ShellUsageMeter() {
  return useHostedMode() ? <ShellUsageMeterBody /> : null;
}
