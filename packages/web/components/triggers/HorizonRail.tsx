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
    // Flat on the page: the baseline is the only line, the ends land on the
    // column edges, and the row chips (violet loops, cyan one-shots) already
    // teach the colors, so there is no legend and no box.
    <div className="mt-2 select-none">
      <div className="relative h-12">
        {/* baseline — the past half sits dimmer */}
        <div className="absolute left-0 right-1/2 top-1/2 h-px bg-sol-border/60" />
        <div className="absolute left-1/2 right-0 top-1/2 h-px bg-sol-border" />
        {/* 12h ticks */}
        {[0.25, 0.75].map((p) => (
          <div key={p} className="absolute top-1/2 -translate-y-1/2 h-2.5 w-px bg-sol-border" style={{ left: `${p * 100}%` }} />
        ))}
        {/* now marker — a full-height cyan line so "the present" reads instantly */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-sol-cyan/50" />
        <div className="absolute left-1/2 top-0 w-1 h-1 -translate-x-1/2 rounded-full bg-sol-cyan" />
        {/* dots */}
        {points.map((pt, i) => {
          const base = pt.task.schedule_type === "recurring" ? "bg-sol-violet" : "bg-sol-cyan";
          const failed = pt.kind === "past" && (isTriggerFailing(pt.task) || pt.task.status === "failed");
          const cls =
            pt.kind === "ghost"
              ? `${base} opacity-25 w-1.5 h-1.5`
              : pt.kind === "past"
                ? `${failed ? "bg-sol-red" : base} opacity-60 group-hover:opacity-100 w-2 h-2`
                : pt.kind === "running"
                  ? "bg-emerald-400 animate-pulse w-2.5 h-2.5"
                  : pt.kind === "due"
                    ? `${base} animate-pulse w-2.5 h-2.5`
                    : `${base} w-2 h-2`;
          const label =
            pt.kind === "running"
              ? "running now"
              : pt.kind === "due"
                ? "due now"
                : pt.kind === "past"
                  ? `${failed ? "failed" : "ran"} ${timeAgo(pt.at)} — open run`
                  : fmtClock(pt.at);
          const dy = pt.lane === 1 ? -6 : pt.lane === 2 ? 6 : 0;
          const style = { left: `${Math.min(Math.max(pt.pct, 0), 1) * 100}%`, marginTop: dy };
          const inner = (
            <>
              <div className={`rounded-full ${cls} group-hover:scale-150 transition-transform`} />
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
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group cursor-pointer p-1.5 -m-1.5"
              style={style}
            >
              {inner}
            </button>
          ) : (
            <div
              key={`${pt.task._id}-${i}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group"
              style={style}
            >
              {inner}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-sol-text-dim font-mono mt-1">
        <span>-24h</span><span>-12h</span><span>now</span><span>+12h</span><span>+24h</span>
      </div>
    </div>
  );
}
