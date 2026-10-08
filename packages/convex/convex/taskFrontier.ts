// `cast task ready --claim` (docs/architecture/task-graph.md TG7): take the
// first task of the ready frontier and start it for the caller in one
// transaction, so two agents pulling from the same queue never take the same
// task. The frontier is tasks.list's (same filters, same readiness, same
// order) and the start is tasks.update's (ownership, role, history, pulse
// side effects), each run as a nested call inside this mutation's
// transaction: a racing claim conflicts and retries against the new state.

import { v } from "convex/values";
import { api } from "./_generated/api";
import { mutation } from "./functions";

/** How many frontier rows one claim may try before it gives up. A row is
 *  passed over only when its start is refused (another live owner, a hold). */
const CLAIM_CANDIDATES = 10;

type ClaimResult = {
  task: { short_id: string; title: string; priority: string } | null;
  plan_id?: string;
  assigned_role?: { handle: string; name: string };
  released_owners?: Array<{ short_id: string; title: string | null; live: boolean }>;
  /** Frontier rows whose start was refused, with the reason. */
  skipped: Array<{ short_id: string; reason: string }>;
};

export const claimNextReady = mutation({
  args: {
    api_token: v.string(),
    // Who claims, as `cast task start` sends it: the caller's own session,
    // else `assignee: "me"` for a person at a terminal.
    conversation_id: v.optional(v.string()),
    assignee: v.optional(v.string()),
    // The ready list's filters.
    project_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    query: v.optional(v.string()),
    label: v.optional(v.string()),
    include_subtasks: v.optional(v.boolean()),
    team: v.optional(v.boolean()),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<ClaimResult> => {
    const { api_token, conversation_id, assignee, ...filters } = args;
    const frontier = await ctx.runQuery(api.tasks.list, { api_token, ...filters, ready: true, limit: CLAIM_CANDIDATES });
    const skipped: ClaimResult["skipped"] = [];
    for (const row of frontier) {
      try {
        const started = await ctx.runMutation(api.tasks.update, {
          api_token,
          short_id: row.short_id,
          status: "in_progress",
          ...(conversation_id ? { conversation_id } : {}),
          ...(assignee ? { assignee } : {}),
        });
        return {
          task: { short_id: row.short_id, title: row.title, priority: row.priority },
          plan_id: started.plan_id,
          assigned_role: started.assigned_role,
          released_owners: started.released_owners,
          skipped,
        };
      } catch (err) {
        // The refused start rolled back on its own; the next row is tried.
        skipped.push({ short_id: row.short_id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { task: null, skipped };
  },
});
