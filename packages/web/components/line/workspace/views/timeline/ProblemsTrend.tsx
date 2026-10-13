"use client";
// The Problems trend (line-journeys.md LJ8.2): findings per day (per hour over
// the last day) as stacked bars, the five busiest problems in colour and the
// rest one neutral band, with a mark under the day a fix was merged or reached
// production. Hovering a bar names what it holds, each problem by its ref and
// count; a coloured segment is the link to its problem and lights that problem
// across every day. No legend: the table under the chart lists every problem.
// With few findings the chart is a short strip; with none it is not drawn.
import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { bucketWords, DAY } from "../../../../../lib/line/timeline";
import type { Overview, OverviewMarker } from "../../../../../lib/line/problemsOverview";
import { problemTitle } from "../../../../../lib/line/problemTable";
import { useDerivedSize } from "../../../../../hooks/useDerivedSize";
import "./timeline.css";
import "./overview.css";

const GUTTER = 30;
const PAD_R = 8;
const TOP = 6;
const MARK_H = 14;
const AXIS_H = 18;
/** Under this many findings in the window there is no shape to read: the chart is a strip. */
const STRIP_UNDER = 10;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hourLabel = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric" });

export const ProblemsTrend = memo(function ProblemsTrend({ overview: o, href, open }: {
  overview: Overview;
  /** A problem's page, by row id: a coloured segment links there. */
  href: (id: string) => string;
  open: (id: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useDerivedSize(boxRef, (w) => Math.max(320, Math.round(w)), () => 900);
  const strip = o.total < STRIP_UNDER;
  const PLOT_H = strip ? 48 : 104;
  const plotW = width - GUTTER - PAD_R;
  const { d0, step, n } = o.win;
  const bw = plotW / n;
  const barW = Math.max(2, Math.min(64, bw - (bw > 10 ? 4 : 1)));
  const y = (v: number) => (v / o.max) * (PLOT_H - 4);
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

  const [hover, setHover] = useState<number | null>(null);
  const [hl, setHl] = useState<string | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const key = (e.target as Element).closest?.("[data-ov]")?.getAttribute("data-ov");
    const next = key == null ? null : Number(key);
    if (next !== hover) setHover(next);
    const seg = (e.target as Element).closest?.("[data-ov-problem]")?.getAttribute("data-ov-problem") ?? null;
    if (seg !== hl) setHl(seg);
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
  const hm = hover == null ? [] : marksBy.get(hover) ?? [];

  return (
    <section className="lwo" data-line-overview={o.total} data-strip={strip ? "" : undefined}>
      <div className="lwo-chart" ref={wrapRef}>
        <div ref={boxRef} className="lwo-box">
          <svg className="lwo-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width }}
            onPointerMove={onMove} onPointerLeave={() => { setHover(null); setHl(null); }} role="img"
            aria-label={`${plural(o.total, "finding")} over the last ${o.win.range}, per ${step >= DAY ? "day" : "hour"}, by problem`}>
            <g className="lwo-grid">
              <line className="lwo-base" x1={GUTTER} x2={GUTTER + plotW} y1={TOP + PLOT_H} y2={TOP + PLOT_H} />
              {o.total > 0 && <text className="lwo-ymax" x={GUTTER - 6} y={TOP + 9}>{o.max}</text>}
            </g>
            <g className="lwo-bars">
              {o.buckets.map((b) => {
                const bx = GUTTER + b.i * bw + (bw - barW) / 2;
                let acc = 0;
                const seg = (v: number, t: Overview["top"][number] | null, key: string) => {
                  if (!v) return null;
                  const h = Math.max(1.5, y(v));
                  const top = TOP + PLOT_H - acc - h;
                  acc += h;
                  const rect = <rect className="lwo-seg" x={bx} y={top} width={barW} height={h} data-slot={t?.slot ?? undefined} data-dim={hl && t?.id !== hl ? "" : undefined} />;
                  if (!t) return <g key={key}>{rect}</g>;
                  return (
                    <a key={key} href={href(t.id)} data-ov-problem={t.id} aria-label={`${t.ref ?? "Problem"}: ${v} ${v === 1 ? "finding" : "findings"}`}
                      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); open(t.id); }}>{rect}</a>
                  );
                };
                const marks = marksBy.get(b.i);
                const cx = GUTTER + b.i * bw + bw / 2;
                const cy = markTop + MARK_H / 2;
                return (
                  <g key={b.i} data-ov={b.i} data-hover={hover === b.i ? "" : undefined}>
                    <rect className="lwo-hit" x={GUTTER + b.i * bw} y={TOP} width={bw} height={height - TOP - AXIS_H} />
                    {/* The rest first, so the coloured problems sit on a neutral base. */}
                    {seg(b.other, null, "other")}
                    {o.top.map((t) => seg(b.byTop[t.slot], t, t.id))}
                    {marks && <rect className="lwo-fix" data-kind={marks.some((m) => m.kind === "production") ? "production" : "merged"} x={cx - 3.5} y={cy - 3.5} width={7} height={7} rx={1} transform={`rotate(45 ${cx} ${cy})`} />}
                    {b.i % every === 0 && <text className="lwo-tick" x={cx} y={axisTop + 13}>{step >= DAY ? dayLabel(b.from) : hourLabel(b.from)}</text>}
                  </g>
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
              {o.top.map((t) => ({ t, v: hb.byTop[t.slot] })).filter((r) => r.v > 0).sort((p, q) => q.v - p.v).map(({ t, v }) => (
                <span key={t.id} className="lwo-tip-row" data-slot={t.slot} data-on={hl === t.id ? "" : undefined}><i aria-hidden /><span className="lwo-tip-ref">{t.ref}</span><span className="lwo-tip-t">{problemTitle(t.title)}</span><span className="lw-num">{v}</span></span>
              ))}
              {hb.other > 0 && <span className="lwo-tip-row" data-slot="other"><i aria-hidden /><span className="lwo-tip-ref" /><span className="lwo-tip-t">Other problems</span><span className="lw-num">{hb.other}</span></span>}
              {hm.map((m, i) => <span key={i} className="lwo-tip-fix" data-kind={m.kind}>{m.kind === "production" ? "Fix in production" : "Fix out, not in production"}: {m.ref ? `${m.ref} ` : ""}{problemTitle(m.title)}</span>)}
            </>
          )}
        </div>
      </div>

      {hasMarks && (
        <div className="lwo-marks" aria-hidden>
          {o.markers.some((m) => m.kind === "production") && <span><i data-kind="production" />fix in production</span>}
          {o.markers.some((m) => m.kind === "merged") && <span><i data-kind="merged" />fix out, not in production</span>}
        </div>
      )}
    </section>
  );
});
