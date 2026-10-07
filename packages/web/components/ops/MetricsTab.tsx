// The Metrics tab: one card per watched metric (X7), its last 60 values as a
// line with the threshold drawn across, the side of it that alerts shaded.
// "Load history" reads each watch's past values from its source
// (metrics.loadHistory), so a chart is full at once instead of one poll at a time.
import Link from "next/link";
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsGroups, useOpsSources, useOpsWatches } from "../../hooks/useSyncOps";
import { formatRelative, relTimeShort } from "../../lib/utils";
import { opsHref } from "./opsPaths";
import { OpsFeedEmpty, ProviderIcon, useOpsFeed } from "./parts";
import type { OpsWatch } from "./opsTypes";

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

export function MetricsTab({ source }: { source: string | null }) {
  const all = useOpsWatches();
  const feed = useOpsFeed("watches");
  const groups = useOpsGroups();
  const now = useCoarseNow(60_000);
  const watches = useMemo(() => (source ? all.filter((w) => w.source_name === source) : all), [all, source]);
  const groupShort = useMemo(() => new Map(groups.map((g) => [g._id, g.short_id])), [groups]);
  // A watch polls PostHog or an app's reader: its card wears its own source's look.
  const sources = useOpsSources();
  const providerOf = useMemo(() => new Map(sources.map((s) => [s._id, s.provider])), [sources]);

  if (watches.length === 0) {
    return (
      <OpsFeedEmpty feeds={[feed]} what="metric watches" title="No watched metrics">
        A watch polls a PostHog query or insight, or an app reader, and alerts when it crosses its line. Add one with{" "}
        <span className="ops-mono">cast metrics add</span>.
      </OpsFeedEmpty>
    );
  }

  const loadable = watches.filter((w) => !w.history?.reading);
  const loadAll = () => {
    const store = useInboxStore.getState();
    for (const w of loadable) store.loadOpsWatchHistory(w._id);
  };

  return (
    <div className="ops-pad">
      <div className="flex items-center gap-2.5 text-[11.5px] mb-3">
        <span className="flex-1 text-sol-text-muted">
          Fill each chart with the last 30 days: an insight's own series, or a HogQL query read again at past times. Past values never alert.
        </span>
        <button type="button" className="ops-btn shrink-0" disabled={loadable.length === 0} onClick={loadAll} data-ops-load-history>
          Load history
        </button>
      </div>
      <div className="ops-watch-grid">
        {watches.map((w) => {
          const short = w.group_id ? groupShort.get(w.group_id) : undefined;
          // Paused reads muted, whatever the last poll said: nothing is watching.
          const ink = w.status === "paused" ? "var(--sol-text-dim)" : w.state === "alert" ? "var(--sol-orange)" : "var(--sol-green)";
          return (
            <div key={w._id} className="ops-card ops-watch" data-state={w.state}>
              <div className="flex items-center gap-2 text-[12.5px]">
                <span className="text-sol-text font-medium truncate flex-1" title={w.query}>{w.name}</span>
                <span className="ops-pill" style={{ color: ink, background: `color-mix(in srgb, ${ink} 12%, transparent)` }}>
                  {w.status === "paused" ? "paused" : w.state}
                </span>
              </div>
              <div className="flex items-baseline gap-2 mt-2">
                <span className="ops-watch-value">{w.last_value === null ? "?" : fmt(w.last_value)}</span>
                <span className="ops-dim text-[11.5px]">
                  alerts {w.direction} {fmt(w.threshold)}
                </span>
              </div>
              <MetricChart watch={w} />
              <div className="flex items-center gap-2 text-[11px] ops-dim mt-1.5">
                <span className="inline-flex items-center gap-1"><ProviderIcon provider={providerOf.get(w.source_id) ?? "posthog"} />{w.source_name ?? "source"}</span>
                <span className="ops-mono">{w.short_id}</span>
                {short && <Link href={opsHref.issue(short)} className="hover:underline ops-mono">{short}</Link>}
                <span className="ml-auto ops-num">{w.last_at ? relTimeShort(w.last_at, now) : "never polled"}</span>
              </div>
              {w.last_error && <div className="text-[11px] mt-1.5" style={{ color: "var(--sol-red)" }}>{w.last_error}</div>}
              <HistoryLine watch={w} now={now} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Where the watch's history read stands: reading, how many past values came over, or why none. */
function HistoryLine({ watch, now }: { watch: OpsWatch; now: number }) {
  const h = watch.history;
  if (!h) return null;
  const read = `${h.added} past value${h.added === 1 ? "" : "s"} from the source, read ${formatRelative(h.at, now)}`;
  const text = h.reading ? "Reading history…" : h.added === 0 && h.note ? `No history: ${h.note}` : h.note ? `${read} (${h.note})` : read;
  return <div className="text-[11px] mt-1 ops-dim" title={h.note}>{text}</div>;
}

/** The points as a line, the threshold as a dashed rule, the alerting side faintly shaded. */
export function MetricChart({ watch, width = 260, height = 56 }: { watch: Pick<OpsWatch, "points" | "threshold" | "direction" | "state">; width?: number; height?: number }) {
  const pts = watch.points;
  const values = pts.map((p) => p.value);
  const lo = Math.min(watch.threshold, ...values);
  const hi = Math.max(watch.threshold, ...values);
  const span = hi - lo || 1;
  const pad = 4;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);
  const x = (i: number) => (pts.length <= 1 ? width : (i / (pts.length - 1)) * width);
  const ty = y(watch.threshold);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const ink = watch.state === "alert" ? "var(--sol-orange)" : "var(--sol-text-muted)";
  return (
    <svg className="w-full mt-2" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" height={height} role="img" aria-label={`last ${pts.length} values, threshold ${watch.threshold}`}>
      <rect x={0} y={watch.direction === "above" ? 0 : ty} width={width} height={watch.direction === "above" ? ty : height - ty} style={{ fill: "color-mix(in srgb, var(--sol-orange) 7%, transparent)" }} />
      <line x1={0} x2={width} y1={ty} y2={ty} style={{ stroke: "var(--sol-orange)" }} strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {pts.length > 1 && <path d={line} fill="none" style={{ stroke: ink }} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
      {pts.length > 0 && <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1].value)} r={2.5} style={{ fill: ink }} />}
    </svg>
  );
}
