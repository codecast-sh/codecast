// A trial project's cards (lineTrial.ts). A line run on a trial project's
// problem goes through every station for real; each gate it reaches is the
// decision of the station that wrote it (trial-flagged, in the trial's stack),
// and one row here indexes that decision by run, node and task and keeps the
// facts the line checked (the change, proposal or judge-fix card). The answer
// routes the run like a gate's answer does; at the card it records what the
// person would have done, and the trial graph ends there, so nothing ships.

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const lineTrialTables = {
  trial_cards: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    project_id: v.id("projects"),
    task_id: v.id("tasks"),
    run_id: v.id("workflow_runs"),
    short_id: v.string(), // "tc-N"
    node_id: v.string(),
    /** card: the change card gate (the run's last stop); gate: any earlier gate, such as the proposal. */
    kind: v.union(v.literal("card"), v.literal("gate")),
    /** The decision the asking station's session posted (or the gate asked from it): its question, options, page and answer are read from there. Rows from before it carry their own question, options and answer. */
    decision_id: v.optional(v.id("session_decisions")),
    question: v.optional(v.string()),
    context_md: v.optional(v.string()),
    doc_md: v.optional(v.string()),
    category: v.optional(v.string()),
    options: v.optional(v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) }))),
    /** The change card, as validated for a decision (shared/contracts/changeCard). */
    card: v.optional(v.any()),
    /** The proposal gate's card (shared/contracts/proposalCard), when its words node wrote one. */
    proposal: v.optional(v.any()),
    /** The judge route's card (shared/contracts/judgeFix): a fix to a judge, its extractor or an expectation, measured on the ruled moments; the project's reviewer answers it. */
    judge_fix: v.optional(v.any()),
    /** waiting: the run is paused on it. answered: a person answered here. closed: the run moved on or ended without an answer. */
    status: v.union(v.literal("waiting"), v.literal("answered"), v.literal("closed")),
    /** stand_in: an agent session answered an earlier gate so the run reaches its card; the card itself is only a person's. via: that session's short id. */
    answer: v.optional(v.object({ key: v.string(), label: v.string(), note: v.optional(v.string()), by: v.id("users"), at: v.number(), stand_in: v.optional(v.boolean()), via: v.optional(v.string()) })),
    /** Set when the card's branch was stale against main and its run was sent back to rebuild there (`cast line trial rebuild`): until the run's next card, it reads Rebuilding. */
    rebuild_at: v.optional(v.number()),
    /** When `cast line trial recard` last replaced the card's content: a count it carries was taken then, not at created_at. */
    carded_at: v.optional(v.number()),
    /** Set when the card's fix was set aside with findings still on its problem (a Drop at the card, or a re-ask finding the fix reaches none of them): the problem went back to the dispatcher's queue for a run from main, whatever the card's answer says. */
    reopened_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace_created", ["workspace", "created_at"])
    // Every waiting card of a workspace, however many newer ones were answered: the team's decision inbox lists them all.
    .index("by_workspace_status_created", ["workspace", "status", "created_at"])
    .index("by_project_created", ["project_id", "created_at"])
    .index("by_run", ["run_id"])
    .index("by_short_id", ["short_id"])
    .index("by_decision", ["decision_id"]),
};
