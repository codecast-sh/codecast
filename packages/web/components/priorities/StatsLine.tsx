// The top of /priorities, one line by default: critical milestones landed in
// ten days (the days in miniature), then where today's messages went, as one
// bar split by priority (the top three strong, the rest lighter, "no
// priority" hatched) and the shares in words, which add up to 100. The No
// priority segment opens today's sessions outside every priority. The
// chevron opens the full band.
import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { PriorityLooseSession } from "@codecast/shared/contracts/priorities";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Mark } from "../Mark";
import { TOUCH_AREA, ago, type Landed, type ListLayout, type TodaySegment, type TodayShare } from "../../lib/priorityList";
import { cn } from "../../lib/utils";

const MAX_MARKS = 8;
const HATCH = "repeating-linear-gradient(135deg, color-mix(in srgb, var(--sol-text-dim) 55%, transparent) 0 2px, transparent 2px 5px)";
const FILL: Record<TodaySegment["tone"], string> = {
  top: "var(--sol-green)",
  rest: "color-mix(in srgb, var(--sol-green) 38%, transparent)",
  none: HATCH,
};

export type TodayView = { segments: TodaySegment[]; parts: TodayShare[]; total: number; topPct: number };

function Parts({ parts }: { parts: TodayShare[] }) {
  return (
    <span data-today-parts className="shrink-0 whitespace-nowrap text-meta tabular-nums text-sol-text-muted">
      {parts.map((x, i) => <span key={x.label}>{i > 0 && " · "}<span className={cn(x.label.startsWith("#") && "font-medium text-sol-text")}>{x.label}</span> {x.pct}%</span>)}
    </span>
  );
}

export function StatsLine({ days, landed, todayIndex, today, loose, now, layout }: {
  days: string[];
  landed: Map<string, Landed[]>;
  todayIndex: number;
  today: TodayView;
  loose: PriorityLooseSession[];
  now: number;
  layout: ListLayout;
}) {
  const [open, setOpen] = useState(false);
  const wide = layout === "wide";
  const all = days.flatMap((d) => landed.get(d) ?? []);
  const critical = all.filter((l) => l.tier === "critical").length;
  const perDay = days.map((d) => (landed.get(d) ?? []).filter((l) => l.tier === "critical").length);
  const peak = Math.max(1, ...perDay);
  return (
    <section data-stats className="mb-2 border-b border-sol-border/60 pb-1">
      {/* Wraps rather than clips: every share, "none" included, stays whole on a narrow list. */}
      <div className={cn("flex w-full flex-wrap items-center gap-x-2 gap-y-1", wide ? "min-h-9" : "min-h-11")}>
        <span className="text-[17px] font-semibold tabular-nums text-sol-text">{critical}</span>
        <span className="shrink-0 text-ui text-sol-text">{wide ? "critical landed · 10d" : "landed"}</span>
        {wide && (
          <Mark id="priority.landed" labeled>
            <span aria-hidden className="flex h-[16px] w-[100px] shrink-0 items-end gap-[3px]">
              {perDay.map((n, i) => <i key={days[i]} className="block flex-1 rounded-[1px] bg-sol-green" style={{ height: n ? Math.max(3, Math.round((n / peak) * 16)) : 1, opacity: n ? 1 : 0.25 }} />)}
            </span>
          </Mark>
        )}
        {today.total > 0 && (
          <>
            <span className="text-sol-text-dim">·</span>
            <span data-today-unit className="shrink-0 text-ui tabular-nums text-sol-text">
              {wide ? `Today · ${today.topPct}% of messages on top 3` : `${today.topPct}% top 3 today`}
            </span>
            {wide && (
              <span className="flex shrink-0 items-center gap-2">
                <TodayBar today={today} loose={loose} now={now} />
                <Parts parts={today.parts} />
              </span>
            )}
          </>
        )}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Fewer details" : "More details"} className={cn("ml-auto flex shrink-0 items-center justify-center rounded text-sol-text-dim hover:bg-sol-bg-alt", wide ? "size-8 [@media(pointer:coarse)]:size-11" : "size-11")}>
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open && (
        <div data-stats-band className={cn("flex gap-6 pt-2", wide ? "items-end" : "flex-col items-stretch gap-3")}>
          <div className="min-w-0 flex-1">
            <div className="grid h-[58px] gap-1.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
              {days.map((d) => {
                const marks = landed.get(d) ?? [];
                return (
                  <div key={d} title={marks.map((m) => `${m.rank != null ? `#${m.rank} ` : ""}${m.title} (${m.priority})${m.tier === "polish" ? " · polish" : ""}`).join("\n") || "Nothing landed"} className="flex flex-col-reverse items-center gap-[2px]">
                    {marks.slice(0, MAX_MARKS).map((m, j) =>
                      m.tier === "polish"
                        ? <i key={j} className="block size-[5px] rounded-[1px] bg-sol-text-muted" />
                        : <i key={j} className={cn("block h-[5px] w-full max-w-[30px] rounded-[1.5px]", (m.rank ?? 99) <= 3 ? "bg-sol-green" : "border border-sol-green")} />,
                    )}
                    {marks.length > MAX_MARKS && <span className="text-mark leading-none text-sol-text-dim">+{marks.length - MAX_MARKS}</span>}
                  </div>
                );
              })}
            </div>
            <div className="mt-1 grid gap-1.5 border-t border-sol-border/60 pt-1 text-center text-mark tabular-nums text-sol-text-dim" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
              {days.map((d, i) => <span key={d} className={cn("whitespace-nowrap", i === todayIndex && "font-semibold text-sol-text")}>{i === todayIndex ? "Today" : Number(d.slice(8))}</span>)}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-mark text-sol-text-dim">
              <span className="inline-flex items-center gap-1"><i className="block h-[5px] w-3 rounded-[1.5px] bg-sol-green" />Top 3</span>
              <span className="inline-flex items-center gap-1"><i className="block h-[5px] w-3 rounded-[1.5px] border border-sol-green" />Other priorities</span>
              <span className="inline-flex items-center gap-1"><i className="block size-[5px] rounded-[1px] bg-sol-text-muted" />Polish</span>
            </div>
          </div>
          {today.total > 0 && (
            <div className={cn("shrink-0 pb-5", wide ? "w-[260px]" : "w-full pb-0")}>
              <div className="flex items-baseline justify-between text-mark font-semibold uppercase tracking-wide text-sol-text-dim">
                <span>Today</span><span className="font-normal normal-case tracking-normal tabular-nums">{today.total} messages</span>
              </div>
              <div className="mt-1.5"><TodayBar today={today} loose={loose} now={now} full /></div>
              <div className="mt-1"><Parts parts={today.parts} /></div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The bar: priorities in rank order, then the hatched No priority share, which opens its sessions. */
function TodayBar({ today, loose, now, full }: { today: TodayView; loose: PriorityLooseSession[]; now: number; full?: boolean }) {
  const [noneOpen, setNoneOpen] = useState(false);
  const none = today.parts.find((p) => p.label === "none");
  return (
    <Popover open={noneOpen} onOpenChange={setNoneOpen}>
      {/* Its words sit beside it on the line, and its heading over it in the band. */}
      <Mark id="priority.today_share" labeled className={full ? "w-full" : undefined}>
        <PopoverAnchor asChild>
          <span data-today-bar className={cn("relative flex shrink-0 gap-px", full ? "h-3 w-full" : "h-[10px] w-[72px]")}>
            {today.segments.map((s) => {
              const style = { flexGrow: s.count, flexBasis: 0, minWidth: 4, background: FILL[s.tone] };
              const look = "block h-full first:rounded-l-[2px] last:rounded-r-[2px]";
              // No priority opens its sessions: a real button, so a keyboard reaches it too.
              return s.tone === "none" ? (
                <button
                  key={s.key}
                  type="button"
                  data-today-seg="none"
                  aria-label="Today's sessions outside every priority"
                  onClick={() => setNoneOpen(true)}
                  title={`${s.title} · ${s.count} messages`}
                  className={cn(look, "cursor-pointer border border-sol-text-dim/50 p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/50", TOUCH_AREA)}
                  style={style}
                />
              ) : (
                <span key={s.key} data-today-seg={s.key} title={`${s.title} · ${s.count} messages`} className={look} style={style} />
              );
            })}
          </span>
        </PopoverAnchor>
      </Mark>
      <PopoverContent align="start" className="w-[22rem] bg-sol-card p-1.5">
        <div data-no-priority className="px-1.5 pb-1 pt-0.5 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">No priority · {none?.pct ?? 0}% of today</div>
        {loose.length === 0 && <div className="px-1.5 py-1 text-meta text-sol-text-dim">No sessions to list</div>}
        {loose.map((x) => (
          <Link key={x.conversation_id} href={`/conversation/${x.conversation_id}`} onClick={() => setNoneOpen(false)} className="flex h-7 min-w-0 items-center gap-2 rounded-control px-1.5 text-meta hover:bg-sol-bg-alt [@media(pointer:coarse)]:h-11">
            <span className="min-w-0 flex-1 truncate text-sol-text">{x.title || "Untitled session"}</span>
            <span className="shrink-0 tabular-nums text-sol-text-dim">{ago(x.last_active_at, now)}</span>
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  );
}
