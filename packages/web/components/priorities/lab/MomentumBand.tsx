// Priorities lab (throwaway prototype): the topline. Milestones landed over the
// last ten days (a block each: top-three priorities solid, the rest outlined,
// polish a small square, so it reads in grayscale), the change against the ten
// days before, and where today's typing went. On a phone it is one line that
// opens.
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../lib/utils";
import type { Landed } from "./labModel";

const MAX_MARKS = 8;

/** Today's typing in one priority (or in no priority). */
export type TodaySegment = { key: string; rank: number | null; title: string; count: number; tone: "top" | "rest" | "none" };

export function MomentumBand({ days, landed, priorCritical, todayIndex, today }: {
  days: string[];
  landed: Map<string, Landed[]>;
  priorCritical: number;
  todayIndex: number;
  today: TodaySegment[];
}) {
  const [open, setOpen] = useState(false);
  const all = days.flatMap((d) => landed.get(d) ?? []);
  const critical = all.filter((l) => l.tier === "critical").length;
  const polish = all.length - critical;
  const delta = critical - priorCritical;
  const total = today.reduce((n, s) => n + s.count, 0);
  const topShare = total ? Math.round((today.filter((s) => s.tone === "top").reduce((n, s) => n + s.count, 0) / total) * 100) : null;
  return (
    <section data-lab-momentum className="mb-4 border-b border-sol-border/60 pb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 text-left [@container(min-width:44rem)]:hidden"
      >
        <span className="text-[20px] font-semibold tabular-nums text-sol-text">{critical}</span>
        <span className="text-ui text-sol-text">landed</span>
        {topShare != null && <><span className="text-sol-text-dim">·</span><span className="text-ui tabular-nums text-sol-text">{topShare}% top 3 today</span></>}
        <ChevronDown className={cn("ml-auto size-4 text-sol-text-dim transition-transform", open && "rotate-180")} />
      </button>
      <div className={cn("hidden items-end gap-6 [@container(min-width:44rem)]:flex", open && "[@container(max-width:44rem)]:mt-2 [@container(max-width:44rem)]:flex [@container(max-width:44rem)]:flex-col [@container(max-width:44rem)]:items-stretch [@container(max-width:44rem)]:gap-3")}>
        <div className="shrink-0 pb-5 [@container(max-width:44rem)]:hidden">
          <div className="flex items-baseline gap-2">
            <span className="text-[28px] font-semibold leading-none tabular-nums text-sol-text">{critical}</span>
            <span className="text-ui text-sol-text">critical landed</span>
          </div>
          <div className="mt-1.5 text-meta tabular-nums text-sol-text-dim">
            <span className={cn(delta > 0 && "text-sol-green", delta < 0 && "text-sol-red")}>{delta >= 0 ? "+" : "−"}{Math.abs(delta)}</span> vs prior {days.length} days
            {polish > 0 && <> · +{polish} polish</>}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="grid h-[58px] gap-1.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((d) => {
              const marks = landed.get(d) ?? [];
              return (
                <div key={d} title={marks.map((m) => `${m.rank != null ? `#${m.rank} ` : ""}${m.title} (${m.priority})${m.tier === "polish" ? " · polish" : ""}`).join("\n") || "Nothing landed"} className="flex flex-col-reverse items-center gap-[2px]">
                  {marks.slice(0, MAX_MARKS).map((m, j) =>
                    m.tier === "polish"
                      ? <i key={j} className="block size-[5px] rounded-[1px] bg-sol-text-muted" />
                      : (m.rank ?? 99) <= 3
                        ? <i key={j} className="block h-[5px] w-full max-w-[30px] rounded-[1.5px] bg-sol-green" />
                        : <i key={j} className="block h-[5px] w-full max-w-[30px] rounded-[1.5px] border border-sol-green" />,
                  )}
                  {marks.length > MAX_MARKS && <span className="text-[9px] leading-none text-sol-text-dim">+{marks.length - MAX_MARKS}</span>}
                </div>
              );
            })}
          </div>
          <div className="mt-1 grid gap-1.5 border-t border-sol-border/60 pt-1 text-center text-[10px] tabular-nums text-sol-text-dim" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((d, i) => <span key={d} className={cn(i === todayIndex && "font-semibold text-sol-text")}>{i === todayIndex ? "Today" : Number(d.slice(8))}</span>)}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-sol-text-dim">
            <span className="inline-flex items-center gap-1"><i className="block h-[5px] w-3 rounded-[1.5px] bg-sol-green" />Top 3</span>
            <span className="inline-flex items-center gap-1"><i className="block h-[5px] w-3 rounded-[1.5px] border border-sol-green" />Other priorities</span>
            <span className="inline-flex items-center gap-1"><i className="block size-[5px] rounded-[1px] bg-sol-text-muted" />Polish</span>
          </div>
        </div>
        <TodayFocus segments={today} />
      </div>
    </section>
  );
}

const TONE: Record<TodaySegment["tone"], string> = {
  top: "var(--sol-green)",
  rest: "color-mix(in srgb, var(--sol-green) 38%, transparent)",
  none: "color-mix(in srgb, var(--sol-text-dim) 35%, transparent)",
};

/** Where today's typing went: one bar split by priority in rank order, the share on the top three, and the biggest three named under it. */
function TodayFocus({ segments }: { segments: TodaySegment[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = segments.reduce((n, s) => n + s.count, 0);
  const top = segments.filter((s) => s.tone === "top").reduce((n, s) => n + s.count, 0);
  const shown = segments.filter((s) => s.count > 0);
  const pct = (n: number) => Math.round((n / Math.max(1, total)) * 100);
  // The three biggest priorities by share, then everything else.
  const ranked = shown.filter((s) => s.rank != null).sort((a, b) => b.count - a.count).slice(0, 3);
  const other = total - ranked.reduce((n, s) => n + s.count, 0);
  const h = shown.find((s) => s.key === hover);
  return (
    <div data-lab-today className="w-[240px] shrink-0 self-end pb-5 [@container(max-width:44rem)]:w-full [@container(max-width:44rem)]:pb-0">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-sol-text-dim">Today</span>
        {total > 0 && <span className="text-meta tabular-nums text-sol-text-dim">{total} typed</span>}
      </div>
      <div className="mt-1.5 flex h-3 w-full gap-px overflow-hidden rounded-[3px] bg-sol-text/[0.06]" onMouseLeave={() => setHover(null)}>
        {shown.map((s) => (
          <span
            key={s.key}
            data-lab-today-seg={s.key}
            onMouseEnter={() => setHover(s.key)}
            title={`${s.title} · ${pct(s.count)}%`}
            className={cn("block h-full transition-opacity", hover && hover !== s.key && "opacity-40")}
            style={{ flexGrow: s.count, flexBasis: 0, minWidth: 3, background: TONE[s.tone] }}
          />
        ))}
      </div>
      <div className="mt-1 text-meta tabular-nums text-sol-text-muted">
        {h ? (
          <span className="block truncate"><span className="font-medium text-sol-text">{h.title}</span> · {pct(h.count)}%</span>
        ) : total > 0 ? (
          <span className="block truncate">
            {ranked.map((s, i) => <span key={s.key}>{i > 0 && " · "}<span className="font-medium text-sol-text">#{s.rank}</span> {pct(s.count)}%</span>)}
            {other > 0 && <> · other {pct(other)}%</>}
          </span>
        ) : (
          <span className="text-sol-text-dim">Nothing typed yet</span>
        )}
      </div>
      {total > 0 && <div className="mt-0.5"><span className="text-[17px] font-semibold tabular-nums text-sol-text">{pct(top)}%</span> <span className="text-meta text-sol-text">on your top 3</span></div>}
    </div>
  );
}
