"use client";
// The bottom of /priorities: where the viewer's last days of messages went,
// one row per workspace on the priority rows' own day columns, busiest first.
// Each day is a stack of priorities 1–3, 4+ and no priority (lib/priorityBreakdown),
// each part with a hover card; on a touch screen a row is one tap target
// whose card lists every day (parts StripTap). Every workspace's history is an
// enrichment read: one that fails or has not answered draws as no messages.
import { useWorkspaceDays } from "../../hooks/useWorkspaceDays";
import { HoverCard } from "../ui/HoverCard";
import {
  TIERS, barHeight, busiestFirst, dayAriaLabel, dayDate, dayTotals, percent, segmentHeights,
  type BreakdownDay, type WorkspaceDays,
} from "../../lib/priorityBreakdown";
import { cn } from "../../lib/utils";
import { StripTap } from "./parts";

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
        // Under a coarse pointer each row is 44px, so its 44px tap target (StripTap) never overlaps the next row's.
        <div key={s.workspace} data-workspace={s.workspace} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-2 py-1.5 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-2">
          <span className="truncate pb-0.5 text-ui text-sol-text">
            {s.name} <span data-workspace-total className="text-meta tabular-nums text-sol-text-dim">{s.total}</span>
          </span>
          <span className="relative flex items-end gap-1 [@container(max-width:40rem)]:gap-[2px]">
            <StripTap label={`Where your messages went in ${s.name}, last ten days`} card={<WorkspaceDaysCard space={s} days={days} todayIndex={todayIndex} />} />
            {s.days.map((d, i) => (
              <DayBar key={days[i]} space={s} day={d} label={dayDate(days[i])} today={i === todayIndex} allThatDay={totals[i]} peak={peak} />
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

const TIER_SHORT: Record<(typeof TIERS)[number]["key"], string> = { top: "1–3", rest: "4+", none: "None" };

/** A workspace's ten days in one card (the touch screen's tap on its row): each day's date, messages and its three parts. */
function WorkspaceDaysCard({ space, days, todayIndex }: { space: WorkspaceDays; days: string[]; todayIndex: number }) {
  const parts = [...TIERS].reverse();
  return (
    <div className="px-3 py-2">
      <div className="mb-1 text-ui font-semibold text-sol-text">{space.name}</div>
      <table className="text-meta tabular-nums">
        <thead>
          <tr className="text-sol-text-dim">
            <th className="pr-4 text-left font-normal">Day</th>
            <th className="pr-3 text-right font-normal">All</th>
            {parts.map((t) => (
              <th key={t.key} className="pr-3 text-right font-normal last:pr-0">
                <span className="inline-flex items-center gap-1"><i aria-hidden className="block size-2 rounded-[2px]" style={{ background: t.fill, opacity: t.opacity }} />{TIER_SHORT[t.key]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {space.days.map((d, i) => (
            <tr key={days[i]} data-strip-day={days[i]}>
              <td className={cn("pr-4", i === todayIndex ? "font-semibold text-sol-text" : "text-sol-text-muted")}>{dayDate(days[i])}</td>
              <td className="pr-3 text-right text-sol-text">{d.total}</td>
              {parts.map((t) => <td key={t.key} className="pr-3 text-right text-sol-text-muted last:pr-0">{d[t.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
