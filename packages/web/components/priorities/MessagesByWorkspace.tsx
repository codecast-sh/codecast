"use client";
// The bottom of /priorities: where the viewer's last days of messages went,
// one row per workspace on the priority rows' own day columns, busiest first.
// Each day is a stack of priorities 1–3, 4+ and no priority (lib/priorityBreakdown),
// each part with a hover card. Every workspace's history and list are
// enrichment reads: one that fails or has not answered draws as no messages.
import { useWorkspaceDays } from "../../hooks/useWorkspaceDays";
import { HoverCard } from "../ui/HoverCard";
import {
  TIERS, barHeight, busiestFirst, dayAriaLabel, dayDate, dayTotals, percent, segmentHeights,
  type BreakdownDay, type WorkspaceDays,
} from "../../lib/priorityBreakdown";
import { cn } from "../../lib/utils";

/** A bar's full height in px. */
const BAR = 28;

/** `days`: local day keys, oldest first, the same the priority rows' strips draw; `todayIndex`: today's place in them. */
export function MessagesByWorkspace({ days, todayIndex }: { days: string[]; todayIndex: number }) {
  const spaces = busiestFirst(useWorkspaceDays(days));
  if (!spaces.length) return null;
  const totals = dayTotals(spaces, days.length);
  const peak = Math.max(1, ...spaces.flatMap((s) => s.days.map((d) => d.total)));
  return (
    <section data-messages-by-workspace className="mt-6 border-t border-sol-border/60 pt-3 [container-type:inline-size]">
      <div className="mb-1 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">Where your messages went</div>
      {spaces.map((s) => (
        <div key={s.workspace} data-workspace={s.workspace} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-2 py-1.5">
          <span className="truncate pb-0.5 text-ui text-sol-text">
            {s.name} <span data-workspace-total className="text-meta tabular-nums text-sol-text-dim">{s.total}</span>
          </span>
          <span className="flex items-end gap-1 [@container(max-width:40rem)]:gap-[2px]">
            {s.days.map((d, i) => (
              <DayBar key={days[i]} space={s} day={d} label={i === todayIndex ? "Today" : dayDate(days[i])} today={i === todayIndex} allThatDay={totals[i]} peak={peak} />
            ))}
          </span>
        </div>
      ))}
    </section>
  );
}

/** One day's stack: no priority on top, 1–3 at the base; a stub for a day with none. */
function DayBar({ space, day, label, today, allThatDay, peak }: { space: WorkspaceDays; day: BreakdownDay; label: string; today: boolean; allThatDay: number; peak: number }) {
  const heights = segmentHeights(day, barHeight(day, peak, BAR));
  return (
    <span data-day role="img" aria-label={dayAriaLabel(label, day)} className="flex w-[20px] flex-col justify-end [@container(max-width:40rem)]:w-[7px]" style={{ height: BAR }}>
      {day.total <= 0 ? (
        <i className={cn("block h-[2px] w-full rounded-[1px]", today ? "bg-sol-green/60" : "bg-sol-text/10")} />
      ) : (
        <span className="flex flex-col gap-px">
          {TIERS.filter((t) => day[t.key] > 0).map((t) => (
            <HoverCard
              key={t.key}
              side="bottom"
              align="center"
              className="w-60"
              triggerClassName="flex w-full"
              focusable
              card={
                <div className="space-y-1.5 p-3">
                  <div className="flex items-center gap-2 text-ui font-semibold text-sol-text">
                    <i className="block size-2.5 rounded-[2px]" style={{ background: t.fill, opacity: t.opacity }} />
                    {t.word}
                  </div>
                  <div className="text-mark text-sol-text-dim">{space.name} · {label}</div>
                  <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-meta">
                    <dt className="text-sol-text-muted">Messages</dt>
                    <dd className="text-right font-medium tabular-nums text-sol-text">{day[t.key]}</dd>
                    <dt className="text-sol-text-muted">Of {space.name} that day</dt>
                    <dd className="text-right font-medium tabular-nums text-sol-text">{percent(day[t.key], day.total)}%</dd>
                    <dt className="text-sol-text-muted">Of all that day</dt>
                    <dd className="text-right font-medium tabular-nums text-sol-text">{percent(day[t.key], allThatDay)}%</dd>
                  </dl>
                </div>
              }
            >
              {/* Focusable by a tap (never a Tab stop), so a touch screen opens the card. */}
              <i data-tier={t.key} tabIndex={-1} className="block w-full rounded-[2px] outline-none hover:brightness-110 focus:brightness-110" style={{ height: heights[t.key], background: t.fill, opacity: t.opacity }} />
            </HoverCard>
          ))}
        </span>
      )}
    </span>
  );
}
