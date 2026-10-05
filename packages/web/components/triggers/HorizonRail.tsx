"use client";

// The /triggers horizon rail: the past 24h of runs and the next 24h of fires
// on one time axis. Props only; the page supplies how a past dot opens its run.

import { useMemo } from "react";
import { fmtClock } from "../triggerCadence";
import { isTriggerFailing, taskDisplayTitle } from "../triggerTasks";
import { timeAgo } from "../../lib/notificationTypes";

const HORIZON_MS = 24 * 3600_000; // each direction from "now"

interface RailPoint {
  pct: number; // 0..1 along the rail; 0 = -24h, 0.5 = now, 1 = +24h
  task: any;
  at: number;
  kind: "running" | "due" | "next" | "ghost" | "past";
  lane: number; // 0 center, 1 above, 2 below — declusters near-coincident dots
}

const railPct = (at: number, now: number) => 0.5 + (at - now) / (2 * HORIZON_MS);

// The plot runs inside the track's padding so end dots never sit on its border:
// 0..1 maps to 1.5%..98.5% of the track.
const INSET = 0.015;
const railLeft = (pct: number) => (INSET + Math.min(Math.max(pct, 0), 1) * (1 - 2 * INSET)) * 100;

// Gridlines every 6h across the 48h window, without the ends or "now".
const GRID = [0.125, 0.25, 0.375, 0.625, 0.75, 0.875];
const AXIS: [number, string][] = [[0, "-24h"], [0.25, "-12h"], [0.5, "now"], [0.75, "+12h"], [1, "+24h"]];

function collectRailPoints(tasks: any[], now: number): RailPoint[] {
  const points: RailPoint[] = [];
  for (const t of tasks) {
    // Past half: each task's latest run — complete coverage for daily cadences;
    // a faster loop shows its newest run. Includes finished one-times.
    if (t.last_run_at && t.last_run_at > now - HORIZON_MS && t.last_run_at <= now) {
      points.push({ pct: railPct(t.last_run_at, now), task: t, at: t.last_run_at, kind: "past", lane: 0 });
    }
    if (t.status === "running") {
      points.push({ pct: 0.5, task: t, at: now, kind: "running", lane: 0 });
      continue;
    }
    if (t.status !== "scheduled" || !t.run_at) continue;
    const dt = t.run_at - now;
    if (dt <= 0) {
      points.push({ pct: 0.5, task: t, at: now, kind: "due", lane: 0 });
    } else if (dt <= HORIZON_MS) {
      points.push({ pct: railPct(t.run_at, now), task: t, at: t.run_at, kind: "next", lane: 0 });
    }
    // Project recurring tasks forward so the rail shows the day's cadence.
    if (t.schedule_type === "recurring" && t.interval_ms) {
      const first = Math.max(dt, 0);
      for (let at = first + t.interval_ms; at <= HORIZON_MS; at += t.interval_ms) {
        points.push({ pct: railPct(now + at, now), task: t, at: now + at, kind: "ghost", lane: 0 });
        if (points.length > 200) break; // sanity cap for tiny intervals
      }
    }
  }
  // Daily tasks created minutes apart land on the same pixel and would hide
  // each other from hover/click — fan near-coincident real dots across lanes.
  const real = points.filter((p) => p.kind !== "ghost").sort((a, b) => a.pct - b.pct);
  for (let i = 1; i < real.length; i++) {
    if (real[i].pct - real[i - 1].pct < 0.012) real[i].lane = (real[i - 1].lane + 1) % 3;
  }
  return points;
}

export function HorizonRail({ tasks, now, onOpenPastRun }: {
  tasks: any[];
  now: number;
  // A past dot's click: the page opens that task's latest run.
  onOpenPastRun: (task: any) => void;
}) {
  const points = useMemo(() => collectRailPoints(tasks, now), [tasks, now]);

  if (points.length === 0) return null;

  return (
    // A grounded strip: a faint track with hour gridlines, the past half
    // shaded so "now" reads as the edge between done and coming. Dots carry a
    // page-colored ring so a cluster stays a set of distinct marks; a loop's
    // projected fires are short cadence ticks under the line, not more dots.
    // The row chips (violet loops, cyan one-shots) already teach the colors.
    <div className="mt-3 select-none">
      <div className="relative h-14 rounded-lg border border-sol-border/40 bg-sol-bg-alt/40 shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)]">
        {/* past half: a soft shade that fades into the present */}
        <div className="pointer-events-none absolute inset-y-0 left-0 right-1/2 rounded-l-lg bg-gradient-to-r from-sol-bg/50 to-sol-bg/10" />
        {/* gridlines every 6h, stronger at the 12h marks */}
        {GRID.map((p) => (
          <div
            key={p}
            className={`pointer-events-none absolute inset-y-2 w-px ${p % 0.25 === 0 ? "bg-sol-border/60" : "bg-sol-border/25"}`}
            style={{ left: `${railLeft(p)}%` }}
          />
        ))}
        {/* baseline */}
        <div className="pointer-events-none absolute inset-x-3 top-1/2 h-px bg-sol-border/80" />
        {/* now: a cyan line with a soft glow and a cap */}
        <div className="pointer-events-none absolute left-1/2 inset-y-0 w-px -translate-x-1/2 bg-sol-cyan/70 shadow-[0_0_6px_var(--sol-cyan)]" />
        <div className="pointer-events-none absolute left-1/2 -top-[3px] h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-sol-cyan ring-2 ring-sol-bg" />
        {/* cadence ticks for projected loop fires */}
        {points.filter((pt) => pt.kind === "ghost").map((pt, i) => (
          <div
            key={`g-${pt.task._id}-${i}`}
            className="pointer-events-none absolute top-1/2 mt-1 h-2 w-px bg-sol-violet/45"
            style={{ left: `${railLeft(pt.pct)}%` }}
          />
        ))}
        {/* dots */}
        {points.map((pt, i) => {
          if (pt.kind === "ghost") return null;
          const base = pt.task.schedule_type === "recurring" ? "bg-sol-violet" : "bg-sol-cyan";
          const failed = pt.kind === "past" && (isTriggerFailing(pt.task) || pt.task.status === "failed");
          const cls =
            pt.kind === "past"
              ? `${failed ? "bg-sol-red" : base} opacity-55 group-hover:opacity-100 w-2 h-2`
              : pt.kind === "running"
                ? "bg-emerald-400 w-2.5 h-2.5"
                : pt.kind === "due"
                  ? `${base} w-2.5 h-2.5`
                  : `${base} w-2 h-2`;
          const halo = pt.kind === "running" ? "bg-emerald-400" : pt.kind === "due" ? base : null;
          const label =
            pt.kind === "running"
              ? "running now"
              : pt.kind === "due"
                ? "due now"
                : pt.kind === "past"
                  ? `${failed ? "failed" : "ran"} ${timeAgo(pt.at)} — open run`
                  : fmtClock(pt.at);
          const dy = pt.lane === 1 ? -8 : pt.lane === 2 ? 8 : 0;
          const style = { left: `${railLeft(pt.pct)}%`, marginTop: dy };
          const inner = (
            <>
              {halo && <span className={`absolute inset-0 m-auto h-2.5 w-2.5 rounded-full ${halo} opacity-60 animate-ping motion-reduce:animate-none`} />}
              <div className={`relative rounded-full ring-2 ring-sol-bg-alt shadow-[0_1px_2px_rgb(0_0_0/0.35)] ${cls} group-hover:scale-150 transition-transform duration-150 ease-out`} />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10 whitespace-nowrap rounded-md border border-sol-border bg-sol-bg-highlight px-2 py-1 text-[11px] text-sol-text shadow-lg pointer-events-none">
                <span className="font-medium">{taskDisplayTitle(pt.task)}</span>
                <span className="text-sol-text-dim"> · {label}</span>
              </div>
            </>
          );
          return pt.kind === "past" ? (
            <button
              key={`${pt.task._id}-${i}`}
              onClick={() => onOpenPastRun(pt.task)}
              aria-label={`Open run: ${taskDisplayTitle(pt.task)}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group cursor-pointer p-1.5 -m-1.5 hover:z-10"
              style={style}
            >
              {inner}
            </button>
          ) : (
            <div
              key={`${pt.task._id}-${i}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group hover:z-10"
              style={style}
            >
              {inner}
            </div>
          );
        })}
      </div>
      {/* axis labels sit under their gridlines */}
      <div className="relative mt-1.5 h-3 font-mono text-[10px] text-sol-text-dim tabular-nums">
        {AXIS.map(([p, text]) => (
          <span
            key={p}
            className={`absolute ${p === 0 ? "" : p === 1 ? "-translate-x-full" : "-translate-x-1/2"} ${p === 0.5 ? "text-sol-cyan" : ""}`}
            style={{ left: `${railLeft(p)}%` }}
          >
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}
