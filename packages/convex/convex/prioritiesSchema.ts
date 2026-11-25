// Priorities (shared/contracts/priorities.ts): what one person is driving at,
// inferred from their own sessions by a pass that runs every few hours, the
// pass's own record of each run, and the trail of pinned states it reads.
//
// A priority carries `workspace` (the access key) and never spans
// workspaces. Pass runs and pin events are their owner's alone
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

const priorityStep = v.object({
  key: v.string(),
  title: v.string(),
  tier: v.union(v.literal("critical"), v.literal("polish")),
  tier_set_by: setBy,
  refs: v.array(priorityRef),
  done: v.boolean(),
  done_at: v.optional(v.number()),
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
    rank: v.optional(v.number()),
    rank_set_by: setBy,
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
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_workspace_status", ["user_id", "workspace", "status"])
    .index("by_workspace_status", ["workspace", "status"])
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
  }).index("by_user_workspace_started", ["user_id", "workspace", "started_at"]),

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
