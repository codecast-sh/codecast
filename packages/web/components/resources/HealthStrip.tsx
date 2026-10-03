"use client";

// One machine's vitals over the last hour: a row of metric cells, each a
// value over its own trace, sharing one hover cursor so every cell reads the
// same moment. A thin band underneath carries the OS memory-pressure state.
import React from "react";
import { sustainedResourcePressure, type ResourcePoint, type ResourcePressure } from "@codecast/shared/contracts";
import { cn } from "../../lib/utils";
import { fmtAgo, fmtBytes, fmtRate, loadPerCore, memoryUsed, memoryUsedPct, type Freshness } from "./resourceModel";
import type { ResourceMachine } from "./types";

type Metric = {
  key: string;
  label: string;
  /** Value plotted, 0..max. Undefined points leave a gap. */
  series: (p: ResourcePoint) => number | undefined;
  max: (pts: ResourcePoint[]) => number;
  value: (p: ResourcePoint) => string;
  detail?: (p: ResourcePoint) => string | undefined;
  tone: string;
  /** Hidden when no point carries the metric. */
  optional?: boolean;
};

const METRICS: Metric[] = [
  {
    key: "cpu", label: "CPU", tone: "text-sol-blue",
    series: (p) => p.cpuPercent, max: () => 100,
    value: (p) => (p.cpuPercent === undefined ? "n/a" : `${p.cpuPercent.toFixed(0)}%`),
    detail: (p) => `${p.logicalCpus} cores`,
  },
  {
    key: "mem", label: "Memory used", tone: "text-sol-violet",
    series: (p) => memoryUsedPct(p), max: () => 100,
    value: (p) => fmtBytes(memoryUsed(p)),
    detail: (p) => [
      `of ${fmtBytes(p.memoryTotal)}${p.memoryAvailableIsEstimate ? " (estimated)" : ""}`,
      p.compressedBytes !== undefined ? `${fmtBytes(p.compressedBytes)} compressed` : undefined,
      p.swapUsedBytes !== undefined ? `swap ${fmtBytes(p.swapUsedBytes)}` : undefined,
    ].filter(Boolean).join(" · "),
  },
  {
    key: "load", label: "System load", tone: "text-sol-orange",
    series: (p) => loadPerCore(p), max: (pts) => Math.max(4, ...pts.map(loadPerCore)),
    value: (p) => `${loadPerCore(p).toFixed(1)} per core`,
    detail: (p) => `1-min load ${p.load1.toFixed(0)} on ${p.logicalCpus} cores`,
  },
  {
    key: "procs", label: "Processes", tone: "text-sol-cyan",
    series: (p) => p.processCount, max: (pts) => Math.max(1, ...pts.map((p) => p.processCount ?? 0)) * 1.1,
    value: (p) => (p.processCount === undefined ? "unavailable" : p.processCount.toLocaleString()),
    detail: (p) => (p.processCount === undefined ? "process list timed out" : p.threadCount === undefined ? "threads not collected" : `${p.threadCount.toLocaleString()} threads`),
  },
  {
    key: "disk", label: "Disk", tone: "text-sol-green", optional: true,
    series: (p) => (p.diskReadBytesPerSecond ?? 0) + (p.diskWriteBytesPerSecond ?? 0) || undefined,
    max: (pts) => Math.max(1, ...pts.map((p) => (p.diskReadBytesPerSecond ?? 0) + (p.diskWriteBytesPerSecond ?? 0))),
    value: (p) => fmtRate(p.diskReadBytesPerSecond === undefined ? undefined : (p.diskReadBytesPerSecond ?? 0) + (p.diskWriteBytesPerSecond ?? 0)),
    detail: (p) => `${fmtRate(p.diskReadBytesPerSecond)} in · ${fmtRate(p.diskWriteBytesPerSecond)} out`,
  },
  {
    key: "net", label: "Network", tone: "text-sol-magenta", optional: true,
    series: (p) => (p.networkReceivedBytesPerSecond ?? 0) + (p.networkSentBytesPerSecond ?? 0) || undefined,
    max: (pts) => Math.max(1, ...pts.map((p) => (p.networkReceivedBytesPerSecond ?? 0) + (p.networkSentBytesPerSecond ?? 0))),
    value: (p) => fmtRate(p.networkReceivedBytesPerSecond === undefined ? undefined : (p.networkReceivedBytesPerSecond ?? 0) + (p.networkSentBytesPerSecond ?? 0)),
    detail: (p) => `${fmtRate(p.networkReceivedBytesPerSecond)} down · ${fmtRate(p.networkSentBytesPerSecond)} up`,
  },
];

const PRESSURE_FILL: Record<ResourcePressure, string> = {
  normal: "fill-sol-green/50",
  elevated: "fill-sol-yellow",
  critical: "fill-sol-red",
  unknown: "fill-sol-text-dim/20",
};

const W = 200;
const H = 36;

/** A trace as an SVG path, split at missing points. */
function tracePath(pts: ResourcePoint[], f: (p: ResourcePoint) => number | undefined, max: number, t0: number, t1: number): { line: string; area: string } {
  const span = Math.max(1, t1 - t0);
  let line = ""; let area = ""; let run: Array<[number, number]> = [];
  const flush = () => {
    if (run.length > 1) {
      line += run.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
      area += `M${run[0][0].toFixed(1)},${H}` + run.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join("") + `L${run[run.length - 1][0].toFixed(1)},${H}Z`;
    }
    run = [];
  };
  for (const p of pts) {
    const v = f(p);
    if (v === undefined) { flush(); continue; }
    run.push([((p.at - t0) / span) * W, H - 2 - Math.min(1, v / max) * (H - 4)]);
  }
  flush();
  return { line, area };
}

function Cell({ m, pts, t0, t1, hover, setHover, dim }: {
  m: Metric; pts: ResourcePoint[]; t0: number; t1: number; hover: number | null; setHover: (i: number | null) => void; dim: boolean;
}) {
  const max = m.max(pts);
  const { line, area } = tracePath(pts, m.series, max, t0, t1);
  const at = pts[hover ?? pts.length - 1];
  const x = hover !== null ? ((pts[hover].at - t0) / Math.max(1, t1 - t0)) * W : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].at - t) < Math.abs(pts[best].at - t)) best = i;
    setHover(best);
  };
  return (
    <div className={cn("min-w-0 px-3 py-2", dim && "opacity-55")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-sol-text-dim">{m.label}</span>
        <span className={cn("text-[13px] font-semibold tabular-nums", m.tone)}>{at ? m.value(at) : "n/a"}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={cn("mt-1 block h-9 w-full touch-none", m.tone)}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${m.label} over the last hour`}
      >
        <path d={area} className="fill-current opacity-[0.12]" />
        <path d={line} className="fill-none stroke-current" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
        {x !== null && <line x1={x} x2={x} y1={0} y2={H} className="stroke-sol-text-muted" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="mt-0.5 truncate text-[10px] text-sol-text-muted" title={at && m.detail?.(at)}>{at && m.detail?.(at)}</div>
    </div>
  );
}

export function HealthStrip({ machine, freshness, now }: { machine: ResourceMachine; freshness: Freshness; now: number }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const pts = machine.history.length ? machine.history : machine.snapshot ? [machine.snapshot.sample] : [];
  if (pts.length === 0) {
    return (
      <div className="border-b border-sol-border/30 px-4 py-6 text-[12px] text-sol-text-muted">
        {freshness === "offline"
          ? <>{machine.name} is offline and has never reported resources.</>
          : <>Waiting for the first sample from {machine.name}. The daemon reports about every 30 seconds once it runs a version with resource reporting.</>}
      </div>
    );
  }
  const t1 = Math.max(pts[pts.length - 1].at, now - 1);
  const t0 = Math.min(pts[0].at, t1 - 60 * 60_000);
  const metrics = METRICS.filter((m) => !m.optional || pts.some((p) => m.series(p) !== undefined));
  const incident = sustainedResourcePressure(pts, now);
  const span = Math.max(1, t1 - t0);
  const dim = freshness !== "live";
  const hoverAt = hover !== null ? pts[hover]?.at : undefined;
  return (
    <div className="border-b border-sol-border/30">
      <div className="grid grid-cols-2 divide-sol-border/20 sm:grid-cols-3 xl:grid-cols-6 [&>*]:border-sol-border/20 [&>*]:border-r [&>*]:border-b xl:[&>*]:border-b-0">
        {metrics.map((m) => <Cell key={m.key} m={m} pts={pts} t0={t0} t1={t1} hover={hover} setHover={setHover} dim={dim} />)}
      </div>
      <div className="relative px-3 pb-2 pt-1">
        <svg viewBox={`0 0 ${W} 4`} preserveAspectRatio="none" className="block h-1 w-full" aria-label="Memory pressure over the last hour">
          {pts.map((p, i) => {
            const next = pts[i + 1]?.at ?? t1;
            return <rect key={p.at} x={((p.at - t0) / span) * W} width={Math.max(0.3, ((next - p.at) / span) * W)} y={0} height={4} className={PRESSURE_FILL[p.pressure]} />;
          })}
        </svg>
        <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-sol-text-dim">
          <span>{hoverAt !== undefined ? fmtAgo(hoverAt, now) : "60 min ago"}</span>
          <span className="truncate">
            {freshness === "stale" && <span className="text-sol-yellow">Last sample {fmtAgo(machine.receivedAt, now)}; values may be out of date · </span>}
            {freshness === "offline" && <span className="text-sol-text-muted">Offline · last sample {fmtAgo(machine.receivedAt, now)} · </span>}
            {incident
              ? <span className={incident.level === "critical" ? "text-sol-red" : "text-sol-yellow"}>{incident.reason} since {fmtAgo(incident.since, now)}</span>
              : <span>memory pressure: {pts[pts.length - 1].pressure}</span>}
          </span>
          <span>now</span>
        </div>
      </div>
    </div>
  );
}

/** A compact trace for the all-machines list. */
export function MiniTrace({ points, f, max, className }: { points: ResourcePoint[]; f: (p: ResourcePoint) => number | undefined; max: number; className?: string }) {
  if (points.length < 2) return <span className={cn("inline-block h-4 w-20", className)} />;
  const { line } = tracePath(points, f, max, points[0].at, points[points.length - 1].at);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("inline-block h-4 w-20", className)}>
      <path d={line} className="fill-none stroke-current" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
