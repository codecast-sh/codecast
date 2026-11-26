// Priorities (shared/contracts/priorities.ts): what one person is driving at,
// inferred from their own sessions by a pass that runs every few hours, the
// pass's own record of each run, and the trail of pinned states it reads.
//
// A priority carries `workspace` (the access key) and never spans
// workspaces. Pass runs, pin events and corrections are their owner's alone
// (lib/accessKeys OWNER_ONLY_TABLES).

import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import type { ThreadStateStatus } from "@codecast/shared/contracts";

export const threadStateStatus = v.union(v.literal("working"), v.literal("blocked"), v.literal("done"), v.literal("dormant"));
// The validator and the contract's status list are the same set.
const _statusMatchesContract: ThreadStateStatus = "" as Infer<typeof threadStateStatus>;
const _contractMatchesStatus: Infer<typeof threadStateStatus> = "" as ThreadStateStatus;
void _statusMatchesContract;
void _contractMatchesStatus;

const setBy = v.union(v.literal("pass"), v.literal("person"));

const priorityRef = v.object({
  kind: v.union(v.literal("task"), v.literal("session"), v.literal("pr"), v.literal("commit")),
  id: v.string(),
});

// A milestone. Every `*_set_by: "person"` field, and `dropped`, is the
// person's: priorityPassRun applyPlan rejects a pass's change to it.
const priorityStep = v.object({
  key: v.string(),
  title: v.string(),
  title_set_by: v.optional(setBy),
  tier: v.union(v.literal("critical"), v.literal("polish")),
  tier_set_by: setBy,
  refs: v.array(priorityRef),
  done: v.boolean(),
  done_at: v.optional(v.number()),
  done_set_by: v.optional(setBy),
  /** The person dropped it: kept as a tombstone the pass reads, never shown. */
  dropped: v.optional(v.boolean()),
});

export const priorityTables = {
  priorities: defineTable({
    user_id: v.id("users"),
    workspace: v.string(),
    short_id: v.string(), // "pri-N"
    title: v.string(),
    summary: v.string(),
    status: v.union(v.literal("active"), v.literal("done"), v.literal("quiet"), v.literal("set_aside"), v.literal("merged")),
    merged_into: v.optional(v.id("priorities")),
    /** "person" when the person marked it done or merged it: the pass never changes its status. */
    status_set_by: v.optional(setBy),
    /**
     * Rank is relative (shared/contracts/priorities effectivePriorityOrder):
     * `person_pos` is where the person placed it, set only by their move;
     * `ai_rank` is where the pass slotted it, on the same scale, between the
     * placed ones. The pass never writes `person_pos`.
     */
    person_pos: v.optional(v.number()),
    ai_rank: v.optional(v.number()),
    /** The initiative short id ("in-5") it serves, if any. */
    serves: v.optional(v.string()),
    steps: v.array(priorityStep),
    first_seen_at: v.number(),
    last_active_at: v.number(),
    done_at: v.optional(v.number()),
    /** The last pass that wrote it. */
    pass_at: v.number(),
    /** How many sessions it holds (conversations.priority_id), kept by the pass as it maps them. */
    session_count: v.optional(v.number()),
    /** The count passed SESSION_COUNT_CAP: it is kept by the moves, not counted. */
    session_count_capped: v.optional(v.boolean()),
    /**
     * It lost a session that left its workspace or was deleted, so its title
     * and summary may tell of work a teammate may no longer see: hidden from
     * teammates until the pass writes them again (priorityPassRun applyPlan).
     */
    needs_rewrite: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_workspace_status", ["user_id", "workspace", "status"])
    .index("by_workspace_status", ["workspace", "status"])
    // Newest first where recency decides what is read: one person's priorities
    // (the pass, the sweep's stray probe) and a workspace's by status (lists).
    .index("by_user_workspace_active", ["user_id", "workspace", "last_active_at"])
    .index("by_workspace_status_active", ["workspace", "status", "last_active_at"])
    .index("by_user_workspace_rewrite", ["user_id", "workspace", "needs_rewrite"])
    .index("by_short_id", ["short_id"]),

  // One run of the pass for one (person, workspace). A run reserves its row as
  // "running" before it asks the model (one at a time per pair; a reservation
  // older than 15 minutes is dead) and settles it when it ends. `cursor_at` is
  // the newest input it read, so the next run reads only what came after.
  priority_pass_runs: defineTable({
    user_id: v.id("users"),
    workspace: v.string(),
    started_at: v.number(),
    finished_at: v.number(),
    status: v.union(v.literal("ok"), v.literal("error"), v.literal("skipped"), v.literal("running")),
    cursor_at: v.number(),
    model: v.string(),
    cost_usd: v.optional(v.number()),
    counts: v.object({ created: v.number(), updated: v.number(), merged: v.number(), mapped_sessions: v.number() }),
    error: v.optional(v.string()),
    /** An error that will happen again on the same input (an unreadable reply, a prompt the call refuses): enough of them step the cursor past it. */
    repeats: v.optional(v.boolean()),
    /** A run of the pair's first catch-up: spent from PRIORITY_PASS_FIRST_USD, never from the daily ceiling. */
    catch_up: v.optional(v.boolean()),
  }).index("by_user_workspace_started", ["user_id", "workspace", "started_at"]),

  // What the person told the pass about one of their priorities (or one of
  // its milestones), in their words. Every later pass in its workspace reads
  // it until the person deletes it; the first that succeeds after reading it
  // marks it applied, with the window that run read (`applied_window`, so a
  // scorer can replay it through evalPass). `snapshot` freezes the priority
  // as the person saw it when they wrote it: with the text, an eval case
  // (priorities exportCases).
  priority_corrections: defineTable({
    user_id: v.id("users"),
    workspace: v.string(),
    priority_id: v.id("priorities"),
    step_key: v.optional(v.string()),
    text: v.string(),
    status: v.union(v.literal("pending"), v.literal("applied")),
    created_at: v.number(),
    applied_at: v.optional(v.number()),
    applied_window: v.optional(v.object({ from: v.number(), to: v.number() })),
    snapshot: v.object({ short_id: v.string(), title: v.string(), summary: v.string(), status: v.string(), steps: v.array(priorityStep) }),
  })
    .index("by_user_workspace_created", ["user_id", "workspace", "created_at"])
    .index("by_priority_created", ["priority_id", "created_at"])
    .index("by_priority_status", ["priority_id", "status"])
    .index("by_workspace", ["workspace"])
    .index("by_user_workspace_status", ["user_id", "workspace", "status"])
    .index("by_applied", ["applied_at"]),

  // Every `cast state` write (conversations.performSetThreadState), kept
  // because the conversation's own pin holds only the latest. Pruned after 30
  // days (threadStateEvents.prune).
  thread_state_events: defineTable({
    conversation_id: v.id("conversations"),
    /** The conversation's runner (conv.user_id). Whether a second-party owner's
     *  sessions also feed their priorities is not decided yet. */
    user_id: v.id("users"),
    at: v.number(),
    text: v.string(),
    status: threadStateStatus,
  })
    .index("by_conversation_at", ["conversation_id", "at"])
    .index("by_user_at", ["user_id", "at"])
    .index("by_at", ["at"]),
};
