// Priorities lab (throwaway prototype): the topline. The last ten days at a
// glance: milestones landed per day (critical solid, polish small) over a
// faint bar of how much was typed that day, beside one figure.
import { useState } from "react";
import { cn } from "../../../lib/utils";
import { TODAY_OUTLINE } from "./LabParts";
import type { Landed } from "./labModel";

const MAX_MARKS = 8;

/** Today's typing in one priority (or in no priority). */
export type TodaySegment = { key: string; title: string; count: number; tone: "top" | "rest" | "none" };

export function MomentumBand({ days, landed, typed, todayIndex, today }: {
  days: string[];
  landed: Map<string, Landed[]>;
  typed: number[];
  todayIndex: number;
  today: TodaySegment[];
}) {
  const all = days.flatMap((d) => landed.get(d) ?? []);
  const critical = all.filter((l) => l.tier === "critical").length;
  const polish = all.length - critical;
  const peak = Math.max(1, ...typed);
  return (
    <section data-lab-momentum className="mb-4 flex items-end gap-5 border-b border-sol-border/60 pb-3 [@container(max-width:30rem)]:flex-col [@container(max-width:30rem)]:items-stretch [@container(max-width:30rem)]:gap-3">
      <div className="shrink-0 pb-5 [@container(max-width:30rem)]:pb-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[28px] font-semibold leading-none tabular-nums text-sol-text">{critical}</span>
          <span className="text-ui text-sol-text">critical milestones landed</span>
        </div>
        <div className="mt-1.5 text-meta tabular-nums text-sol-text-dim">
          {polish > 0 && <><span className="text-sol-text-muted">+{polish} polish</span> · </>}
          last {days.length} days
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="grid h-[60px] gap-1.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d, i) => {
            const marks = landed.get(d) ?? [];
            return (
              <div
                key={d}
                title={marks.length ? marks.map((m) => `${m.tier === "critical" ? "●" : "·"} ${m.title} (${m.priority})`).join("\n") : `${typed[i]} typed`}
                className="relative flex flex-col-reverse items-center gap-[2px] rounded-[3px] px-1 pb-[2px]"
                style={i === todayIndex ? TODAY_OUTLINE : undefined}
              >
                <span aria-hidden className="absolute inset-x-0 bottom-0 rounded-[3px] bg-sol-text/[0.06]" style={{ height: `${Math.round((typed[i] / peak) * 100)}%` }} />
                {marks.slice(0, MAX_MARKS).map((m, j) => (
                  <i key={j} className={cn("relative block max-w-[34px] rounded-[1.5px]", m.tier === "critical" ? "h-[5px] w-full bg-sol-green" : "h-[3px] w-3/5 bg-sol-green/45")} />
                ))}
                {marks.length > MAX_MARKS && <span className="relative text-[9px] leading-none text-sol-text-dim">+{marks.length - MAX_MARKS}</span>}
              </div>
            );
          })}
        </div>
        <div className="mt-1 grid gap-1.5 text-center text-[10px] tabular-nums text-sol-text-dim" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d, i) => (
            <span key={d} className={cn(i === todayIndex && "font-semibold text-sol-text")}>{i === todayIndex ? "Today" : Number(d.slice(8))}</span>
          ))}
        </div>
      </div>
      <TodayFocus segments={today} />
    </section>
  );
}

const TONE: Record<TodaySegment["tone"], string> = {
  top: "var(--sol-green)",
  rest: "color-mix(in srgb, var(--sol-green) 38%, transparent)",
  none: "color-mix(in srgb, var(--sol-text-dim) 35%, transparent)",
};

/** Where today's typing went: one bar split by priority in rank order (top three strong), and the share on the top three. */
function TodayFocus({ segments }: { segments: TodaySegment[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = segments.reduce((n, s) => n + s.count, 0);
  const top = segments.filter((s) => s.tone === "top").reduce((n, s) => n + s.count, 0);
  const shown = segments.filter((s) => s.count > 0);
  const h = shown.find((s) => s.key === hover);
  const pct = (n: number) => `${Math.round((n / Math.max(1, total)) * 100)}%`;
  return (
    <div data-lab-today className="w-[220px] shrink-0 self-end pb-5 [@container(max-width:30rem)]:w-full [@container(max-width:30rem)]:pb-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-sol-text-dim">Today</div>
      <div className="mt-1.5 flex h-3 w-full gap-px overflow-hidden rounded-[3px] bg-sol-text/[0.06]" onMouseLeave={() => setHover(null)}>
        {shown.map((s) => (
          <span
            key={s.key}
            data-lab-today-seg={s.key}
            onMouseEnter={() => setHover(s.key)}
            className={cn("block h-full transition-opacity", hover && hover !== s.key && "opacity-40")}
            style={{ flexGrow: s.count, flexBasis: 0, minWidth: 3, background: TONE[s.tone] }}
          />
        ))}
      </div>
      <div className="mt-1.5 h-[34px] text-meta leading-tight">
        {h ? (
          <>
            <div className="truncate font-medium text-sol-text">{h.title}</div>
            <div className="tabular-nums text-sol-text-dim">{pct(h.count)} · {h.count} typed</div>
          </>
        ) : total > 0 ? (
          <>
            <div><span className="text-[17px] font-semibold tabular-nums text-sol-text">{pct(top)}</span> <span className="text-sol-text">on your top 3</span></div>
            <div className="tabular-nums text-sol-text-dim">{total} typed today</div>
          </>
        ) : (
          <div className="text-sol-text-dim">Nothing typed yet</div>
        )}
      </div>
    </div>
  );
}
