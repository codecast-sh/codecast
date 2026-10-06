import { v } from "convex/values";

// The change guide on a task (ct-57527, @codecast/shared/contracts/changeGuide):
// the author's walkthrough written at handoff, each step's hunk captured then
// so the guide survives later edits. Kept off list rows and the sync log; the
// task's evidence (taskEvidence.get) carries it to the review station.
export const changeGuideStepValidator = v.object({
  title: v.string(),
  why: v.string(),
  file: v.string(),
  start: v.optional(v.number()),
  end: v.optional(v.number()),
  hunk: v.optional(v.string()),
  truncated: v.optional(v.boolean()),
});

export const changeGuideInputValidator = v.object({
  summary: v.optional(v.string()),
  steps: v.array(changeGuideStepValidator),
});

export const changeGuideValidator = v.object({
  summary: v.optional(v.string()),
  steps: v.array(changeGuideStepValidator),
  written_at: v.number(),
});
