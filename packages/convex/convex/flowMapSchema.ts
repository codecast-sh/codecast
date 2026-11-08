// The flow map's rollup (flowMap.ts): per workspace with a live flow, what its
// sources filed per day, where their problems stand, and its open event
// groups no problem took. Reading those live is tens of thousands of findings
// a day, so the hourly pass writes one row and the Flows page reads it.

import { defineTable } from "convex/server";
import { v } from "convex/values";

const dayCount = v.object({ day: v.string(), n: v.number() });
export const flowMapOutcomesValidator = v.object({
  queued: v.number(), notReady: v.number(), running: v.number(), waiting: v.number(),
  shipped: v.number(), closed: v.number(), failed: v.number(), parked: v.number(), total: v.number(),
});

const reasonCounts = v.record(v.string(), v.number());
// How far the problems opened in each window got through the live flow (shared/contracts/lineFunnel.ts FlowFunnel).
export const flowFunnelValidator = v.object({
  at: v.number(),
  windows: v.array(v.object({
    days: v.number(),
    signals: v.number(),
    sources: v.array(v.object({ key: v.string(), n: v.number() })),
    steps: v.array(v.object({ key: v.string(), label: v.string(), n: v.number(), drops: reasonCounts })),
  })),
  items: v.array(v.object({
    task: v.string(), ref: v.union(v.string(), v.null()), title: v.string(), run: v.union(v.string(), v.null()), at: v.number(),
    level: v.number(), why: v.union(v.string(), v.null()), node: v.union(v.string(), v.null()), status: v.union(v.string(), v.null()),
  })),
});

export const flowMapTables = {
  flow_map_rollups: defineTable({
    workspace: v.string(),
    rolled_at: v.number(),
    // By signals.source: findings per UTC day (FUNNEL_DAYS; the map's rows show the last FLOW_MAP_DAYS), the newest, problems opened in
    // FLOW_MAP_OUTCOME_DAYS by where they stand, and problems that ran off the live flow in FLOW_MAP_ESCAPE_DAYS.
    sources: v.array(v.object({
      key: v.string(),
      days: v.array(dayCount),
      last_at: v.optional(v.number()),
      outcomes: flowMapOutcomesValidator,
      escapes: v.number(),
    })),
    // By event source and transition: events per day, the newest, and open groups that never became a problem.
    events: v.array(v.object({
      source_id: v.id("event_sources"),
      transition: v.string(),
      days: v.array(dayCount),
      last_at: v.optional(v.number()),
      unfiled: v.number(),
    })),
    // Every open problem (any age): open, scored, ready with no run.
    problems_open: v.number(),
    problems_scored: v.number(),
    queued: v.number(),
    // Problems a finding reopened while they were under watch (LE12), newest reopening each, in the window.
    reopened: v.array(v.object({ task_id: v.string(), at: v.number() })),
    // The Flows page's Volume chart; absent on a row from before it, which the next pass recounts in full.
    funnel: v.optional(flowFunnelValidator),
  }).index("by_workspace", ["workspace"]),
};
