// A task's predicted effect on a goal metric and its read after ship
// (shared/contracts/predictedEffect.ts). `due_at` is the sweep's queue key
// (predictions.ts): when to look next, cleared once the read is written.
import { v } from "convex/values";
import { PREDICTION_VERDICTS } from "@codecast/shared/contracts/predictedEffect";

export const predictedValidator = v.object({
  goal_ref: v.string(),
  direction: v.union(v.literal("up"), v.literal("down")),
  size: v.number(),
  relative: v.boolean(),
  read_at: v.optional(v.number()),
  read_days: v.optional(v.number()),
  basis: v.string(),
  set_at: v.number(),
  series: v.optional(v.string()),
  due_at: v.optional(v.number()),
});

export const realisedValidator = v.object({
  verdict: v.union(...PREDICTION_VERDICTS.map((x: (typeof PREDICTION_VERDICTS)[number]) => v.literal(x))),
  value_before: v.union(v.number(), v.null()),
  value_after: v.union(v.number(), v.null()),
  delta: v.union(v.number(), v.null()),
  within_noise: v.union(v.boolean(), v.null()),
  band: v.union(v.number(), v.null()),
  shipped_at: v.union(v.number(), v.null()),
  from: v.union(v.number(), v.null()),
  to: v.union(v.number(), v.null()),
  read_at: v.number(),
  source: v.optional(v.string()),
  note: v.string(),
});
