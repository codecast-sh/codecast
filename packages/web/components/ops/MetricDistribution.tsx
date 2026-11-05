// A watch's values in the chart's window as a distribution: percentiles,
// spread and a histogram, and for a plain series the alert lines its own
// history suggests (p95, p99, three standard deviations out), each with how
// often it would have fired, drawn on the chart while pointed at and set
// with one press.
import { useMemo, useState } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { crosses, formatMeasure, measuresCount, type Direction, type Pt } from "./metricModel";
import { distribution, sharePast, lineSuggestions, suggestDirection } from "./metricEvents";
import { readCount } from "./metricSeries";
import type { OpsWatch } from "./opsTypes";

export function DistributionCard({ watch, history, named, loading = false, provisional = false, onDraft }: { watch: OpsWatch; history: readonly Pt[]; /** The chart's window as the page names it (metricModel windowName). */ named: { short: string; within: string }; /** No values for the window have come yet: a skeleton, never "too few". */ loading?: boolean; /** Read off a stored answer while the window's own is on its way. */ provisional?: boolean; onDraft?: (line: number | undefined) => void }) {
  const d = useMemo(() => distribution(history), [history]);
  // The reads behind the window, whatever the chart folded them to: a longer window never names fewer than a shorter one.
  const reads = useMemo(() => readCount(history), [history]);
  // A count keeps a count's precision at every range: judged on the values the watch read, not on a range's folded means.
  const integral = useMemo(() => measuresCount(watch.points, history), [watch.points, history]);
  // A watch with no line has no side yet: start on the side its values stray to.
  const [picked, setDirection] = useState<Direction | null>(null);
  const direction = picked ?? suggestDirection(history);
  const suggestions = useMemo(() => (watch.threshold === undefined ? lineSuggestions(history, direction) : []), [history, direction, watch.threshold]);
  const update = useInboxStore((s) => s.updateOpsWatch);
  const fmt = (v: number) => formatMeasure(v, watch.unit, integral);
  const top = d ? Math.max(...d.bins) : 0;
  // The alert line on the histogram: a red tick at its value, the bins past it in the alert colour, and how much of the window sat past it.
  const line = watch.threshold ?? null;
  const at = (v: number) => (d && d.max > d.min ? `${((v - d.min) / (d.max - d.min)) * 100}%` : "0%");
  const pastBin = (i: number) => {
    if (!d || line === null || d.max === d.min) return false;
    const mid = d.min + ((i + 0.5) / d.bins.length) * (d.max - d.min);
    return crosses(mid, line, watch.direction);
  };
  const pctPast = useMemo(() => (line === null ? 0 : sharePast(history, line, watch.direction)), [history, line, watch.direction]);
  return (
    <div className="ops-card" data-watch-distribution data-provisional={provisional ? "" : undefined} aria-busy={provisional || undefined}>
      <div className="ops-card-head">
        <span>Distribution</span>
        <span className="ops-dim ops-num font-normal text-[11.5px]" title={d ? `${d.n} points drawn${reads > d.n ? `, ${reads} reads folded into them` : ""}${d.uneven ? "; each counts for as long as it stood" : ""}` : undefined}>{d ? `${reads.toLocaleString()} ${reads === 1 ? "read" : "reads"} · ${named.short}${d.uneven ? " · time-weighted" : ""}` : ""}</span>
      </div>
      {loading ? (
        <div className="ops-card-body" aria-busy="true" data-dist-loading>
          <span className="mx-skel" style={{ height: 30, marginBottom: 10 }} />
          <span className="mx-skel" style={{ height: 54, opacity: 0.6 }} />
        </div>
      ) : !d ? (
        <div className="ops-card-body ops-dim text-[12px]">Too few values {named.within}</div>
      ) : (
        <div className="ops-card-body">
          <div className="mx-dist-stats" style={line !== null ? { gridTemplateColumns: "repeat(6, minmax(0, 1fr))" } : undefined}>
            {([["p50", d.p50], ["p90", d.p90], ["p95", d.p95], ["p99", d.p99], ["σ", d.sd]] as const).map(([k, v]) => (
              <div key={k} data-dist={k}><span>{k}</span><b className="ops-num">{fmt(v)}</b></div>
            ))}
            {line !== null && <div data-dist="past" title={`Share of the time ${named.within} past the line (${watch.direction} ${fmt(line)})`}><span>past line</span><b className="ops-num" style={pctPast ? { color: "var(--sol-red)" } : undefined}>{pctPast}%</b></div>}
          </div>
          <div className="mx-hist" aria-label={`Values from ${fmt(d.min)} to ${fmt(d.max)}${line !== null ? `, ${pctPast}% past the line` : ""}`} role="img">
            {d.bins.map((c, i) => <i key={i} style={{ height: `${top ? Math.max(c ? 6 : 0, (c / top) * 100) : 0}%` }} data-count={Math.round(c * 10) / 10} data-past={pastBin(i) ? "" : undefined} />)}
            <span className="mx-hist-mark" data-mark="p50" style={{ left: at(d.p50) }} title={`p50 ${fmt(d.p50)}`} />
            {line !== null && line >= d.min && line <= d.max && <span className="mx-hist-mark" data-mark="line" style={{ left: at(line) }} title={`line ${fmt(line)}`} data-hist-line />}
          </div>
          <div className="mx-hist-axis ops-num"><span>{fmt(d.min)}</span><span>{fmt(d.max)}</span></div>
          {watch.threshold === undefined && (
            <div className="mx-suggest" data-line-suggest>
              <div className="mx-suggest-head">
                <span>Add alert line</span>
                <span className="mx-seg" role="group" aria-label="Alert when the value is">
                  {(["above", "below"] as const).map((dir) => (
                    <button key={dir} type="button" aria-pressed={direction === dir} onClick={() => setDirection(dir)} data-suggest-direction={dir}>{dir === "above" ? "Above" : "Below"}</button>
                  ))}
                </span>
              </div>
              {suggestions.length === 0 ? <div className="ops-dim text-[12px]">{d.max === d.min ? "The values do not vary" : `Nothing ${direction} that would have fired ${named.within}`}</div> : (
                <ul>
                  {suggestions.map((s) => (
                    <li key={s.key} onPointerEnter={() => onDraft?.(s.value)} onPointerLeave={() => onDraft?.(undefined)} data-suggest={s.key}>
                      <span className="ops-dim">{s.label}</span>
                      <b className="ops-num">{direction === "above" ? ">" : "<"} {fmt(s.value)}</b>
                      <span className="ops-num" data-tone={s.crossings ? "bad" : undefined} data-suggest-crossings={s.crossings}>{s.crossings}× {named.within}</span>
                      <button type="button" className="ops-btn" onFocus={() => onDraft?.(s.value)} onBlur={() => onDraft?.(undefined)} onClick={() => { onDraft?.(undefined); update(watch._id, { threshold: s.value, direction }); }} data-suggest-set={s.key}>Set</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
