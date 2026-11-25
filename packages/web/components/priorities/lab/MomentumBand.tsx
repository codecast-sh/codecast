// Priorities lab (throwaway prototype): the last ten days at a glance:
// milestones landed per day (critical solid, polish small), over a faint bar
// of how much was typed that day. Its columns are the rows' strip columns.
import { cn } from "../../../lib/utils";
import { LAB_GRID, TODAY_OUTLINE } from "./LabParts";
import type { Landed } from "./labModel";

const MAX_MARKS = 7;

export function MomentumBand({ days, landed, typed, todayIndex }: {
  days: string[];
  landed: Map<string, Landed[]>;
  typed: number[];
  todayIndex: number;
}) {
  const all = days.flatMap((d) => landed.get(d) ?? []);
  const critical = all.filter((l) => l.tier === "critical").length;
  const polish = all.length - critical;
  const peak = Math.max(1, ...typed);
  return (
    <section data-lab-momentum className={cn(LAB_GRID, "mb-5 border-b border-sol-border/60 pb-4")}>
      <div className="min-w-0 self-end pb-5">
        <div className="flex items-baseline gap-2">
          <span className="text-[28px] font-semibold leading-none tabular-nums text-sol-text">{critical}</span>
          <span className="text-ui text-sol-text">critical milestones landed</span>
        </div>
        <div className="mt-1.5 text-meta tabular-nums text-sol-text-dim">
          {polish > 0 && <><span className="text-sol-text-muted">+{polish} polish</span> · </>}
          last {days.length} days
        </div>
      </div>
      <div className="col-span-2 [@container(min-width:44rem)]:col-span-1">
        <div className="grid h-[58px] gap-[4px]" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d, i) => {
            const marks = landed.get(d) ?? [];
            const shown = marks.slice(0, MAX_MARKS);
            return (
              <div
                key={d}
                title={marks.length ? marks.map((m) => `${m.tier === "critical" ? "●" : "·"} ${m.title} (${m.priority})`).join("\n") : `${typed[i]} typed`}
                className={cn("relative flex flex-col-reverse items-center gap-[2px] rounded-[3px] px-[2px] pb-[2px]")}
                style={i === todayIndex ? TODAY_OUTLINE : undefined}
              >
                <span aria-hidden className="absolute inset-x-0 bottom-0 rounded-[3px] bg-sol-text/[0.06]" style={{ height: `${Math.round((typed[i] / peak) * 100)}%` }} />
                {shown.map((m, j) => (
                  <i key={j} className={cn("relative block rounded-[1.5px]", m.tier === "critical" ? "h-[5px] w-full bg-sol-green" : "h-[3px] w-3/5 bg-sol-green/45")} />
                ))}
                {marks.length > MAX_MARKS && <span className="relative text-[9px] leading-none text-sol-text-dim">+{marks.length - MAX_MARKS}</span>}
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 grid gap-[4px] text-center text-[10px] tabular-nums text-sol-text-dim" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d, i) => (
            <span key={d} className={cn(i === todayIndex && "font-semibold text-sol-text")}>{Number(d.slice(8))}</span>
          ))}
        </div>
      </div>
      <span className="hidden [@container(min-width:44rem)]:block" />
    </section>
  );
}
