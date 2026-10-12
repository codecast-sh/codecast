"use client";
// The Problems home's chart (line-workspace.md LW1 Problems): every problem's
// findings in the window as stacked bars, the busiest problems in their own
// colors and the rest gray, what came back after a close hatched red on top,
// and the closes and shipped fixes marked under the bars. Hover names what a
// bar holds; dragging across picks a span and clicking a problem's band picks
// that problem, and either narrows the list below.
import { memo, useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import { bucketWords, momentWords, timeTicks } from "../../../../../lib/line/timeline";
import { OVERVIEW_RANGES, type Overview, type OverviewFocus, type OverviewMarker, type OverviewRange } from "../../../../../lib/line/problemsOverview";
import { useDerivedSize } from "../../../../../hooks/useDerivedSize";
import "./timeline.css";
import "./overview.css";

const GUTTER = 34;
const PAD_R = 10;
const TOP = 8;
const PLOT_H = 112;
const MARK_H = 18;
const AXIS_H = 20;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Hover = { kind: "bucket"; i: number } | { kind: "marks"; i: number } | null;

export const ProblemsOverview = memo(function ProblemsOverview({ overview: o, range, onRange, focus, onFocus, focusWords }: {
  overview: Overview;
  range: OverviewRange;
  onRange: (r: OverviewRange) => void;
  focus: OverviewFocus | null;
  onFocus: (f: OverviewFocus | null) => void;
  /** The focus in words for its chip: the problem's ref and title, or the span. */
  focusWords: string | null;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useDerivedSize(boxRef, (w) => Math.max(360, Math.round(w)), () => 900);
  const plotW = width - GUTTER - PAD_R;
  const { d0, d1, step } = o.win;
  const x = useCallback((t: number) => GUTTER + ((t - d0) / (d1 - d0)) * plotW, [d0, d1, plotW]);
  const tAt = useCallback((px: number) => d0 + ((px - GUTTER) / plotW) * (d1 - d0), [d0, d1, plotW]);
  const bw = plotW / o.win.n;
  const barW = Math.max(2, bw - (bw > 8 ? 2 : 1));
  const y = (n: number) => (n / o.max) * (PLOT_H - 6);
  const hasMarks = o.markers.length > 0;
  const markTop = TOP + PLOT_H + 4;
  const axisTop = markTop + (hasMarks ? MARK_H : 0);
  const height = axisTop + AXIS_H;
  const ticks = useMemo(() => timeTicks([d0, d1], Math.max(3, Math.floor(plotW / 96))), [d0, d1, plotW]);
  const marksBy = useMemo(() => {
    const m = new Map<number, OverviewMarker[]>();
    for (const k of o.markers) { const i = Math.min(o.win.n - 1, Math.floor((k.at - d0) / step)); m.set(i, [...(m.get(i) ?? []), k]); }
    return m;
  }, [o.markers, o.win.n, d0, step]);

  const [hover, setHover] = useState<Hover>(null);
  const [hl, setHl] = useState<string | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const brushRef = useRef<SVGRectElement>(null);
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);
  const localX = (e: { clientX: number }) => { const r = svgRef.current?.getBoundingClientRect(); return r ? ((e.clientX - r.left) / r.width) * width : 0; };
  const clampX = (v: number) => Math.max(GUTTER, Math.min(GUTTER + plotW, v));

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const px = localX(e);
    const el = (e.target as Element).closest?.("[data-ov]");
    const key = el?.getAttribute("data-ov") ?? null;
    const next: Hover = key ? (key.startsWith("m") ? { kind: "marks", i: Number(key.slice(1)) } : { kind: "bucket", i: Number(key.slice(1)) }) : null;
    if (next?.kind !== hover?.kind || next?.i !== hover?.i) setHover(next);
    const prob = (e.target as Element).getAttribute?.("data-problem") ?? null;
    if (prob !== hl) setHl(prob);
    const dr = drag.current;
    if (dr && !dr.moved && Math.abs(px - dr.x0) > 4) { dr.moved = true; svgRef.current?.setPointerCapture(e.pointerId); }
    if (dr?.moved && brushRef.current) {
      const a = clampX(Math.min(dr.x0, px));
      const b = clampX(Math.max(dr.x0, px));
      brushRef.current.setAttribute("x", String(a));
      brushRef.current.setAttribute("width", String(b - a));
    }
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (tipRef.current && wrap) {
      // Right of the pointer while it fits, else left of it, so the tip never leaves the chart.
      const w = tipRef.current.offsetWidth || 300;
      const at = e.clientX - wrap.left;
      const left = at + 14 + w <= wrap.width ? at + 14 : at - 14 - w;
      tipRef.current.style.transform = `translate(${Math.max(0, left)}px, ${e.clientY - wrap.top + 16}px)`;
    }
  };
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const px = localX(e);
    if (px >= GUTTER && px <= GUTTER + plotW) drag.current = { x0: px, moved: false };
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const dr = drag.current;
    drag.current = null;
    brushRef.current?.setAttribute("width", "0");
    if (!dr) return;
    if (dr.moved) {
      const a = tAt(clampX(Math.min(dr.x0, localX(e))));
      const b = tAt(clampX(Math.max(dr.x0, localX(e))));
      if (b - a >= 5 * 60_000) onFocus({ kind: "range", from: a, to: b });
      return;
    }
    // A click: a problem's band picks the problem; anywhere else in a bucket picks its span.
    const prob = (e.target as Element).getAttribute?.("data-problem");
    if (prob) { onFocus(focus?.kind === "problem" && focus.id === prob ? null : { kind: "problem", id: prob }); return; }
    const key = (e.target as Element).closest?.("[data-ov]")?.getAttribute("data-ov");
    if (key) { const b = o.buckets[Number(key.slice(1))]; if (b) onFocus({ kind: "range", from: b.from, to: b.to }); }
  };

  const fRange = focus?.kind === "range" ? focus : null;
  const fProblem = focus?.kind === "problem" ? focus.id : null;
  const dim = (id: string | null) => (fProblem && id !== fProblem) || (hl && id !== hl);
  const hb = hover?.kind === "bucket" ? o.buckets[hover.i] : null;
  const hm = hover?.kind === "marks" ? marksBy.get(hover.i) ?? [] : null;
  const ships = o.markers.filter((m) => m.kind === "ship").length;
  const closes = o.markers.length - ships;

  return (
    <section className="lwo" data-line-overview={o.total}>
      <div className="lwo-head">
        <div className="lw-seg" role="tablist" aria-label="Window">
          {OVERVIEW_RANGES.map((r) => <button key={r} type="button" role="tab" aria-selected={range === r} onClick={() => onRange(r)} data-line-overview-range={r}>{r}</button>)}
        </div>
        <dl className="lwo-totals">
          <div><dt>Findings</dt><dd className="lw-num">{o.total}</dd></div>
          <div title="Problems with a finding in this window"><dt>Problems hit</dt><dd className="lw-num">{o.top.length + o.other.problems}</dd></div>
          <div data-tone={o.back ? "bad" : undefined}><dt>Came back</dt><dd className="lw-num">{o.back}</dd></div>
          {ships > 0 && <div data-tone="ok"><dt>Fixes shipped</dt><dd className="lw-num">{ships}</dd></div>}
          {closes > 0 && <div><dt>Closed, no change</dt><dd className="lw-num">{closes}</dd></div>}
        </dl>
        <span className="lw-spacer" />
        {focus && focusWords && (
          <button type="button" className="lw-chip lwo-focus" data-on="" onClick={() => onFocus(null)} title="Show every problem" data-line-overview-focus={focus.kind}>
            <span className="lw-chip-t">{focusWords}</span><X aria-hidden />
          </button>
        )}
      </div>

      <div className="lwo-chart" ref={wrapRef}>
        <div ref={boxRef} className="lwo-box">
          <svg ref={svgRef} className="lwo-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width }}
            onPointerMove={onMove} onPointerDown={onDown} onPointerUp={onUp} onPointerLeave={() => { setHover(null); setHl(null); }}
            role="img" aria-label={`Findings over the last ${range}, by problem`}>
            <defs>
              <pattern id="lwo-back" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="5" height="5" className="lwo-back-bg" /><rect width="2" height="5" className="lwo-back-stripe" />
              </pattern>
            </defs>
            <g className="lwo-grid">
              {ticks.map((t) => <line key={t.at} x1={x(t.at)} x2={x(t.at)} y1={TOP} y2={TOP + PLOT_H} data-major={t.major ? "" : undefined} />)}
              <line className="lwo-base" x1={GUTTER} x2={GUTTER + plotW} y1={TOP + PLOT_H} y2={TOP + PLOT_H} />
              <text className="lwo-ymax" x={GUTTER - 6} y={TOP + 9}>{o.max}</text>
              <text className="lwo-ymax" x={GUTTER - 6} y={TOP + PLOT_H}>0</text>
            </g>
            {fRange && <rect className="lwo-picked" x={clampX(x(fRange.from))} y={TOP} width={Math.max(2, clampX(x(fRange.to)) - clampX(x(fRange.from)))} height={PLOT_H} />}
            <g className="lwo-bars">
              {o.buckets.map((b) => {
                const bx = GUTTER + b.i * bw + (bw - barW) / 2;
                let acc = 0;
                const seg = (n: number, id: string | null, slot: number | null, key: string) => {
                  if (!n) return null;
                  const h = Math.max(1.5, y(n));
                  const top = TOP + PLOT_H - acc - h;
                  acc += h;
                  return <rect key={key} className="lwo-seg" x={bx} y={top} width={barW} height={h} data-slot={slot ?? undefined} data-problem={id ?? undefined} data-dim={dim(id) ? "" : undefined} />;
                };
                const segs = [...o.top.map((t) => seg(b.byTop[t.slot], t.id, t.slot, t.id)), seg(b.other, null, null, "other")];
                const backH = b.back ? Math.min(acc, Math.max(2, y(b.back))) : 0;
                return (
                  <g key={b.i} data-ov={`b${b.i}`} data-hover={hb?.i === b.i ? "" : undefined}>
                    <rect className="lwo-hit" x={GUTTER + b.i * bw} y={TOP} width={bw} height={PLOT_H} />
                    {segs}
                    {backH > 0 && <rect className="lwo-back" x={bx} y={TOP + PLOT_H - acc} width={barW} height={backH} pointerEvents="none" />}
                  </g>
                );
              })}
            </g>
            {!o.total && <text className="lwo-none" x={GUTTER + plotW / 2} y={TOP + PLOT_H / 2}>No findings in the last {range}</text>}
            {hasMarks && (
              <g className="lwo-marks">
                {[...marksBy].map(([i, ms]) => {
                  const cx = GUTTER + i * bw + bw / 2;
                  const cy = markTop + MARK_H / 2;
                  const ship = ms.some((m) => m.kind === "ship");
                  const close = ms.some((m) => m.kind === "close");
                  return (
                    <g key={i} data-ov={`m${i}`} className="lwo-mark">
                      <rect className="lwo-hit" x={cx - 9} y={markTop} width={18} height={MARK_H} />
                      {ship && <rect className="lwo-ship" x={cx - 4.5 - (close ? 4 : 0)} y={cy - 4.5} width={9} height={9} rx={1.5} transform={`rotate(45 ${cx - (close ? 4 : 0)} ${cy})`} />}
                      {close && <rect className="lwo-close" x={cx - 1.25 + (ship ? 5 : 0)} y={cy - 6} width={2.5} height={12} rx={1} />}
                      {bw >= 44 && <text className="lwo-mark-n" x={cx + 8} y={cy + 3.5}>{markLabel(ms)}</text>}
                    </g>
                  );
                })}
              </g>
            )}
            <g className="lwo-ticks">
              {ticks.map((t) => <text key={t.at} x={x(t.at)} y={axisTop + 14} data-major={t.major ? "" : undefined}>{t.label}</text>)}
            </g>
            <rect ref={brushRef} className="lwo-brush" x={0} y={TOP} width={0} height={PLOT_H} pointerEvents="none" />
          </svg>
        </div>
        <div ref={tipRef} className="lwt-tip lwo-tip" data-open={hb || hm?.length ? "" : undefined} role="tooltip">
          {hb && <BucketTip b={hb} o={o} step={step} />}
          {hm && hm.length > 0 && (
            <>
              <b>{[hm.some((m) => m.kind === "ship") ? plural(hm.filter((m) => m.kind === "ship").length, "fix shipped", "fixes shipped") : null, hm.some((m) => m.kind === "close") ? plural(hm.filter((m) => m.kind === "close").length, "close without a change", "closes without a change") : null].filter(Boolean).join(", ")}</b>
              {hm.slice(0, 8).map((m, i) => <span key={i}>{m.ref ?? "problem"}: {m.words}, {momentWords(m.at)}</span>)}
              {hm.length > 8 && <span>and {hm.length - 8} more</span>}
            </>
          )}
        </div>
      </div>

      <div className="lwo-legend" aria-label="Problems in the chart">
        <div className="lwo-legend-problems">
        {o.top.map((t) => (
          <button key={t.id} type="button" className="lwo-key" data-slot={t.slot} aria-pressed={fProblem === t.id} onClick={() => onFocus(fProblem === t.id ? null : { kind: "problem", id: t.id })}
            onPointerEnter={() => setHl(t.id)} onPointerLeave={() => setHl(null)} title={`${t.ref ?? ""} ${t.title}: ${plural(t.n, "finding")} in the last ${range}`} data-line-overview-problem={t.id}>
            <i aria-hidden /><span className="lw-mono">{t.ref}</span><span className="lwo-key-t">{t.title}</span><span className="lw-num">{t.n}</span>
          </button>
        ))}
        {o.other.n > 0 && <span className="lwo-key" data-slot="other"><i aria-hidden />{plural(o.other.problems, "other problem")}<span className="lw-num">{o.other.n}</span></span>}
        </div>
        {o.back > 0 && <span className="lwo-key" data-slot="back"><i aria-hidden />came back after a close</span>}
        {ships > 0 && <span className="lwo-key" data-slot="ship"><i aria-hidden />fix shipped</span>}
        {closes > 0 && <span className="lwo-key" data-slot="close"><i aria-hidden />closed without a change</span>}
      </div>
    </section>
  );
});

/** What a mark under the bars says in place: one event names its problem; several say what they count. */
function markLabel(ms: ReadonlyArray<OverviewMarker>): string {
  if (ms.length === 1) return ms[0].ref ?? (ms[0].kind === "ship" ? "fix shipped" : "closed");
  const ships = ms.filter((m) => m.kind === "ship").length;
  return ships === ms.length ? `${ships} fixes` : ships === 0 ? `${ms.length} closed` : `${ms.length} events`;
}

function BucketTip({ b, o, step }: { b: Overview["buckets"][number]; o: Overview; step: number }) {
  const rows = o.top.map((t) => ({ t, n: b.byTop[t.slot] })).filter((r) => r.n > 0).sort((p, q) => q.n - p.n);
  return (
    <>
      <b>{b.total ? plural(b.total, "finding") : "No findings"}</b>
      <span className="lwo-tip-when">{bucketWords(b.from, step)}</span>
      {rows.map(({ t, n }) => (
        <span key={t.id} className="lwo-tip-row" data-slot={t.slot}><i aria-hidden /><span className="lwo-tip-t">{t.ref} {t.title}</span><span className="lw-num">{n}</span></span>
      ))}
      {b.other > 0 && <span className="lwo-tip-row" data-slot="other"><i aria-hidden /><span className="lwo-tip-t">Other problems</span><span className="lw-num">{b.other}</span></span>}
      {b.back > 0 && <span className="lwo-tip-row" data-slot="back"><i aria-hidden /><span className="lwo-tip-t">Came back after a close</span><span className="lw-num">{b.back}</span></span>}
      <em>Click a color for that problem, anywhere else for this span; drag to pick a span</em>
    </>
  );
}
