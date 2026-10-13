"use client";
// The Problems trend (line-journeys.md LJ8.2): findings per day (per hour over
// the last day) as bars on a counted axis, with a mark under the day a fix was
// merged or reached production. A bar is a control: pressing it narrows the
// table to the problems found that day, busiest first, and pressing it again
// lifts that. Hovering a bar names its busiest problems by ref and count; the
// table under the chart is the list. With few findings the chart is a short
// strip; with none it is not drawn.
import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { bucketWords, DAY } from "../../../../../lib/line/timeline";
import type { FinderShift, Overview, OverviewMarker } from "../../../../../lib/line/problemsOverview";
import { sourceChipWords } from "../../../../../lib/line/stepRuns";
import { problemListName } from "../../../../../lib/line/problemTable";
import { useDerivedSize } from "../../../../../hooks/useDerivedSize";
import "./timeline.css";
import "./overview.css";

const GUTTER = 34;
const PAD_R = 8;
const TOP = 8;
const MARK_H = 14;
const AXIS_H = 18;
/** Under this many findings in the window there is no shape to read: the chart is a strip. */
const STRIP_UNDER = 10;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hourLabel = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric" });

/** Round axis values: 0, a round middle and the top they reach (358 reads 0 · 200 · 400). */
function axisTicks(max: number): number[] {
  const raw = max / 2;
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Math.round(i * step));
}

/** What a finder's shift did to the bars, in a line: "Union evals filed none after Oct 9 · 293 in the 4 days before". */
export function shiftWords(f: FinderShift, d0: number, step: number): string {
  const name = sourceChipWords({ source: f.source, judge: f.judge });
  const days = plural(f.beforeDays, "day");
  return f.kind === "stopped"
    ? `${name} filed none after ${dayLabel(f.lastAt ?? d0 + (f.from - 1) * step)} · ${f.before} in the ${days} before`
    : `${name} filed ${f.after} from ${dayLabel(d0 + f.from * step)} · ${f.before} in the ${days} before`;
}

export const ProblemsTrend = memo(function ProblemsTrend({ overview: o, picked, pick, href, shifts = [], finderHref, openFinder }: {
  overview: Overview;
  /** The bar the table is narrowed to, by its start; null when none is. */
  picked: number | null;
  /** Narrow the table to a bar's problems, or lift it (null). */
  pick: (from: number | null) => void;
  /** The address a bar opens, for a new tab and for the link's own sake. */
  href: (from: number | null) => string;
  /** Finders that stopped or ran far less in the window: their bars carry a band, and each is a link to the finder. */
  shifts?: ReadonlyArray<FinderShift>;
  finderHref?: (key: string) => string;
  openFinder?: (key: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useDerivedSize(boxRef, (w) => Math.max(320, Math.round(w)), () => 900);
  const strip = o.total < STRIP_UNDER;
  const PLOT_H = strip ? 48 : 112;
  const plotW = width - GUTTER - PAD_R;
  const { d0, step, n } = o.win;
  const bw = plotW / n;
  const barW = Math.max(2, Math.min(64, bw - (bw > 10 ? 4 : 1)));
  const ticks = useMemo(() => (strip ? [0, o.max] : axisTicks(o.max)), [strip, o.max]);
  const yTop = ticks[ticks.length - 1] || 1;
  const y = (v: number) => (v / yTop) * PLOT_H;
  const marksBy = useMemo(() => {
    const m = new Map<number, OverviewMarker[]>();
    for (const k of o.markers) { const i = Math.min(n - 1, Math.max(0, Math.floor((k.at - d0) / step))); m.set(i, [...(m.get(i) ?? []), k]); }
    return m;
  }, [o.markers, n, d0, step]);
  const hasMarks = marksBy.size > 0;
  const markTop = TOP + PLOT_H + 3;
  const axisTop = markTop + (hasMarks ? MARK_H : 0);
  const height = axisTop + AXIS_H;
  // A label under every bar while they fit; else every k-th, so none collide.
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 58))));
  const when = (t: number) => (step >= DAY ? dayLabel(t) : hourLabel(t));

  const [hover, setHover] = useState<number | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const key = (e.target as Element).closest?.("[data-ov]")?.getAttribute("data-ov");
    const next = key == null ? null : Number(key);
    if (next !== hover) setHover(next);
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (tipRef.current && wrap) {
      // Right of the pointer while it fits, else left of it, so the tip never leaves the chart.
      const w = tipRef.current.offsetWidth || 300;
      const at = e.clientX - wrap.left;
      const left = at + 14 + w <= wrap.width ? at + 14 : at - 14 - w;
      tipRef.current.style.transform = `translate(${Math.max(0, left)}px, ${e.clientY - wrap.top + 16}px)`;
    }
  };
  const hb = hover == null ? null : o.buckets[hover] ?? null;
  const hs = hover == null ? [] : shifts.filter((f) => hover >= f.from);
  // The earliest bar any shift reaches: one band from there to the end, behind the bars.
  const shiftFrom = shifts.length ? Math.min(...shifts.map((f) => f.from)) : null;
  const hm = hover == null ? [] : marksBy.get(hover) ?? [];

  return (
    <section className="lwo" data-line-overview={o.total} data-strip={strip ? "" : undefined} data-picked={picked != null ? "" : undefined}>
      <div className="lwo-chart" ref={wrapRef}>
        <div ref={boxRef} className="lwo-box">
          <svg className="lwo-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width }}
            onPointerMove={onMove} onPointerLeave={() => setHover(null)}
            aria-label={`${plural(o.total, "finding")} over the last ${o.win.range}, per ${step >= DAY ? "day" : "hour"}`}>
            <g className="lwo-grid" aria-hidden>
              {ticks.map((t) => {
                const ty = TOP + PLOT_H - y(t);
                return (
                  <g key={t}>
                    <line className={t === 0 ? "lwo-base" : "lwo-rule"} x1={GUTTER} x2={GUTTER + plotW} y1={ty} y2={ty} />
                    <text className="lwo-ymax" x={GUTTER - 6} y={ty + 3.5}>{t}</text>
                  </g>
                );
              })}
            </g>
            {shiftFrom != null && shiftFrom < n && <rect className="lwo-shift" aria-hidden x={GUTTER + shiftFrom * bw} y={TOP} width={(n - shiftFrom) * bw} height={PLOT_H} data-line-overview-shift={shiftFrom} />}
            <g className="lwo-bars">
              {o.buckets.map((b) => {
                const on = picked === b.from;
                const h = b.total ? Math.max(1.5, y(b.total)) : 0;
                const marks = marksBy.get(b.i);
                const cx = GUTTER + b.i * bw + bw / 2;
                const cy = markTop + MARK_H / 2;
                const label = `${bucketWords(b.from, step)}: ${b.total ? plural(b.total, "finding") : "no findings"}${on ? ", listed below" : ""}`;
                return (
                  <a key={b.i} href={href(on ? null : b.from)} data-ov={b.i} data-hover={hover === b.i ? "" : undefined} data-on={on ? "" : undefined} data-line-overview-bar={b.from}
                    aria-label={label} aria-current={on ? "true" : undefined}
                    onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); pick(on ? null : b.from); }}>
                    <rect className="lwo-hit" x={GUTTER + b.i * bw} y={TOP} width={bw} height={height - TOP} />
                    {h > 0 && <rect className="lwo-seg" x={GUTTER + b.i * bw + (bw - barW) / 2} y={TOP + PLOT_H - h} width={barW} height={h} rx={Math.min(2, barW / 4)} />}
                    {marks && <rect className="lwo-fix" data-kind={marks.some((m) => m.kind === "production") ? "production" : "merged"} x={cx - 3.5} y={cy - 3.5} width={7} height={7} rx={1} transform={`rotate(45 ${cx} ${cy})`} />}
                    {(b.i % every === 0 || on) && <text className="lwo-tick" x={cx} y={axisTop + 13}>{when(b.from)}</text>}
                  </a>
                );
              })}
            </g>
          </svg>
        </div>
        <div ref={tipRef} className="lwt-tip lwo-tip" data-open={hb ? "" : undefined} role="tooltip">
          {hb && (
            <>
              <b>{hb.total ? plural(hb.total, "finding") : "No findings"}</b>
              <span className="lwo-tip-when">{bucketWords(hb.from, step)}</span>
              {hb.top.map((t) => (
                <span key={t.id} className="lwo-tip-row"><span className="lwo-tip-ref">{t.ref}</span><span className="lwo-tip-t">{problemListName(t)}</span><span className="lw-num">{t.n}</span></span>
              ))}
              {hb.rest > 0 && <span className="lwo-tip-row"><span className="lwo-tip-ref" /><span className="lwo-tip-t">Other problems</span><span className="lw-num">{hb.rest}</span></span>}
              {hs.map((f) => <span key={f.key} className="lwo-tip-shift">{shiftWords(f, d0, step)}</span>)}
              {hm.map((m, i) => <span key={i} className="lwo-tip-fix" data-kind={m.kind}>{m.kind === "production" ? "Fix in production" : "Fix out, not in production"}: {m.ref ? `${m.ref} ` : ""}{problemListName(m)}</span>)}
            </>
          )}
        </div>
      </div>

      {shifts.length > 0 && (
        <div className="lwo-shifts" data-line-finder-shifts={shifts.length}>
          {shifts.map((f) => (
            <a key={f.key} className="lwo-shift-l" href={finderHref?.(f.key)} data-line-finder-shift={f.key}
              onClick={(e) => { if (!openFinder || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); openFinder(f.key); }}>
              <i aria-hidden />{shiftWords(f, d0, step)}
            </a>
          ))}
        </div>
      )}
      {hasMarks && (
        <div className="lwo-marks" aria-hidden>
          {o.markers.some((m) => m.kind === "production") && <span><i data-kind="production" />fix in production</span>}
          {o.markers.some((m) => m.kind === "merged") && <span><i data-kind="merged" />fix out, not in production</span>}
        </div>
      )}
    </section>
  );
});
