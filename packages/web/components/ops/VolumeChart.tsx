// Count over time as stacked bars, the chart every tool in this space leads
// with. A count axis on the left and time ticks under it; hover a bar for its
// time and each series' count; drag across it to pick a range (the stream
// below narrows to it). Deploys stand as lines over the bars, merged into one
// "3 deploys" mark where their labels would collide. A span nothing recorded
// (before a counter's first day) is shaded and named, never drawn as zero.
import { useState, type PointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { clusterByPixels, isMidnight, niceMax, rangeTicks, seriesLabel, stackKeys, STACK_INK, tickBudget, unknownUntil, type HistBin } from "./timelineModel";
import { MARK_PX, endAnchored, mergeFacing, useWidth } from "./volumeChartLayout";
import { tickLabel } from "./timelineTabModel";
import "./sourceView.css";

export type ChartMark = { at: number; label: string; href?: string; title?: string };

const when = (at: number, span: number) =>
  new Date(at).toLocaleString([], span > 3 * 86_400_000 ? { month: "short", day: "numeric", hour: "numeric" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** A bin's own span as a person reads it: a day's bar is that day, an hour's is its hour. */
const binWhen = (b: HistBin) => {
  const w = b.to - b.from;
  if (w >= 86_400_000) return new Date(b.from).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const t = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${new Date(b.from).toLocaleDateString([], { month: "short", day: "numeric" })}, ${t(b.from)} to ${t(b.to)}`;
};
const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
/** The grid reaches this far above the plot, so the top tick's label is not cut in half. */
const GRID_PAD = 8;

export function VolumeChart({
  bins,
  range,
  marks = [],
  onBrush,
  height = 72,
  ink = (k) => STACK_INK[k] ?? "var(--sol-text-muted)",
  name = seriesLabel,
  empty,
  label,
  silence,
  dated,
}: {
  bins: HistBin[];
  range: { from: number; to: number };
  marks?: ChartMark[];
  onBrush?: (from: number, to: number) => void;
  height?: number;
  ink?: (key: string) => string;
  /** A series' name for the legend and the tooltip. */
  name?: (key: string) => string;
  /** Shown over a chart with nothing in it. */
  empty?: ReactNode;
  label?: string;
  /** A source known to have sent nothing since `from`: drawn as a flat, named stretch to the right edge rather than as missing data. */
  silence?: { from: number; label: string } | null;
  /** The window needs its date (windowDated): the first tick and each midnight name the day. */
  dated?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const keys = stackKeys(bins);
  const max = niceMax(Math.max(1, ...bins.map((b) => b.total)));
  const span = Math.max(1, range.to - range.from);
  const total = bins.reduce((n, b) => n + b.total, 0);
  const frac = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
  };
  const at = (f: number) => range.from + f * span;
  const xOf = (t: number) => Math.min(1, Math.max(0, (t - range.from) / span));
  const groups = mergeFacing(clusterByPixels(marks.filter((m) => m.at >= range.from && m.at <= range.to).map((m) => ({ ...m, x: xOf(m.at) })), width, MARK_PX), width);
  const hb = hover !== null ? bins[hover] : null;
  const ticks = rangeTicks(range, tickBudget(width));
  const unknownTo = unknownUntil(bins);
  const known = bins.filter((b) => !b.unknown);

  return (
    <div className="ovc" data-ops-volume={label ?? ""}>
      <div
        ref={ref}
        className="ovc-plot"
        style={{ height }}
        role="img"
        aria-label={`${label ?? "Volume"}: ${total.toLocaleString()} in range`}
        data-brush={onBrush ? "true" : undefined}
        onPointerDown={(e) => {
          if (!onBrush || e.button !== 0 || (e.target as Element).closest("a")) return;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          const f = frac(e);
          setDrag({ a: f, b: f });
        }}
        onPointerMove={(e) => {
          const f = frac(e);
          if (drag) setDrag({ ...drag, b: f });
          setHover(Math.min(bins.length - 1, Math.floor(f * bins.length)));
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={() => {
          if (!drag || !onBrush) return;
          const lo = Math.min(drag.a, drag.b);
          const hi = Math.max(drag.a, drag.b);
          setDrag(null);
          if (hi - lo > 0.01) onBrush(at(lo), at(hi));
        }}
      >
        {/* No axis over nothing: a count scale on an empty chart is a made-up number. */}
        {total > 0 && (
          <div className="ovc-grid" aria-hidden>
            <span className="ovc-y ops-num" style={{ top: GRID_PAD }}>{compact(max)}</span>
            {/* Counts are whole: the halfway line is labelled only when it falls on a whole number. */}
            {Number.isInteger(max / 2) && <span className="ovc-y ops-num" style={{ top: `calc(50% + ${GRID_PAD / 2}px)` }}>{compact(max / 2)}</span>}
          </div>
        )}
        <div className="ovc-bars">
          {bins.map((b, i) => (
            <div key={b.from} className="ovc-col" data-hover={hover === i ? "true" : undefined} data-unknown={b.unknown ? "true" : undefined} data-estimated={b.estimated ? "true" : undefined}>
              {keys.map((k) =>
                b.parts[k] ? <i key={k} style={{ height: `${(b.parts[k] / max) * 100}%`, background: ink(k) }} /> : null,
              )}
            </div>
          ))}
        </div>
        {unknownTo !== null && (
          <div className="ovc-nodata" style={{ width: unknownTo === Infinity ? "100%" : `${xOf(unknownTo) * 100}%` }} data-ops-nodata>
            {/* An empty range says so once, centred over the whole chart, rather than two labels fighting for a strip. */}
            {!(total === 0 && empty && known.length > 0) && (unknownTo === Infinity || width === 0 || xOf(unknownTo) * width > 150) && <span>{unknownTo === Infinity ? "No data recorded for this range" : `No data before ${new Date(unknownTo).toLocaleDateString([], { month: "short", day: "numeric" })}`}</span>}
          </div>
        )}
        {total === 0 && empty && known.length > 0 && unknownTo !== Infinity ? <div className="ovc-empty" data-ops-empty>{empty}</div> : null}
        {silence && silence.from < range.to && (
          <div className="ovc-silence" style={{ left: `${xOf(silence.from) * 100}%` }} data-ops-silence>
            {(width === 0 || (1 - xOf(silence.from)) * width > 90) && <span>{silence.label}</span>}
          </div>
        )}
        {groups.map((g) => {
          const one = g.marks.length === 1 ? g.marks[0] : null;
          const tip = g.marks.map((m) => `${m.label}  ${when(m.at, span)}`).join("\n");
          return (
            <div key={g.marks[0].at} className="ovc-mark" style={{ left: `${g.x * 100}%` }} data-edge={endAnchored(g.x, width) ? "end" : undefined}>
              {one?.href ? (
                <Link href={one.href} className="ovc-mark-label ops-mono" title={one.title ?? tip}>{one.label}</Link>
              ) : (
                <span className="ovc-mark-label ops-mono" title={tip} data-many={one ? undefined : "true"}>{one ? one.label : `${g.marks.length} deploys`}</span>
              )}
            </div>
          );
        })}
        {drag && <div className="ovc-brush" style={{ left: `${Math.min(drag.a, drag.b) * 100}%`, width: `${Math.abs(drag.b - drag.a) * 100}%` }} />}
        {hb && !drag && (
          <div className="ovc-tip" style={{ left: `${((hover! + 0.5) / bins.length) * 100}%` }} data-edge={hover! / bins.length > 0.7 ? "end" : hover! / bins.length < 0.2 ? "start" : undefined} data-ops-tip>
            <span className="ops-dim">{binWhen(hb)}</span>
            {hb.unknown ? (
              <span className="ops-dim">No data recorded</span>
            ) : hb.estimated ? (
              <>
                <b className="ops-num">≥ {hb.total.toLocaleString()}</b>
                <span className="ops-dim">no counter here; drawn from the issues and replays kept</span>
              </>
            ) : (
              <>
                <b className="ops-num">{hb.total.toLocaleString()}</b>
                {keys.filter((k) => hb.parts[k]).map((k) => (
                  <span key={k} className="ovc-tip-row"><i style={{ background: ink(k) }} />{name(k)}<b className="ops-num">{hb.parts[k].toLocaleString()}</b></span>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <div className="ovc-x" aria-hidden>
        {ticks.map((t, i) => <span key={t.at} className="ovc-tick ops-num" style={{ left: `${t.x * 100}%` }}>{tickLabel(t.at, span, !!dated && (i === 0 || isMidnight(t.at)))}</span>)}
      </div>
      {(keys.length > 1 || keys.includes("estimated")) && (
        <div className="ovc-legend">
          {keys.map((k) => <span key={k}><i style={{ background: ink(k) }} data-estimated={k === "estimated" ? "true" : undefined} />{name(k)}</span>)}
        </div>
      )}
    </div>
  );
}
