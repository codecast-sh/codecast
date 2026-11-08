// What landed on a repository's main and what later fixed it (docs/architecture/regret.md R1).
// One row per commit on main the nightly trace saw, written only by
// landedChanges.record: the session that wrote it (resolved once, through the
// blame resolver), the run it came through, and every traced fix whose diff
// changed its lines. A fix commit is a change too, with its own row.

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const landedChangeTables = {
  landed_changes: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(), // owner/name, normalized
    sha: v.string(),
    subject: v.string(),
    // When it reached main: the commit time on main (the nightly reads main's own history).
    landed_at: v.number(),
    // The session that wrote it, the run that session worked under, and the role it worked for, when the blame resolver finds them.
    conversation_id: v.optional(v.id("conversations")),
    run_id: v.optional(v.id("workflow_runs")),
    role_id: v.optional(v.id("org_roles")),
    via: v.optional(v.string()),
    // When this change is itself a fix, how it was known (lineFixloop selectFixCommits).
    fix_reason: v.optional(v.string()),
    // The traced fixes that changed this change's lines: the fix's sha, when it landed, how many of this change's
    // lines it changed, and `top`, the most lines any one change gave that fix (this change is the fix's top
    // introducer when lines equals top). Every link is kept; which ones regret is the reader's rule (regret.md R3).
    fixed_by: v.array(v.object({ sha: v.string(), at: v.number(), lines: v.number(), top: v.optional(v.number()) })),
    recorded_at: v.number(),
  })
    .index("by_repository_sha", ["repository", "sha"])
    .index("by_workspace_landed", ["workspace", "landed_at"])
    .index("by_repository_landed", ["repository", "landed_at"]),
};
