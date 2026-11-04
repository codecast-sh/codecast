// Tables behind deploys as a first-class part of the system
// (docs/architecture/deploys.md DP10 to DP14): each repository's declared
// deploy targets, CI on its default branch per commit, and each pass of
// `cast ship checkout`. Deploys themselves are the `deploys` table (schema.ts).
//
// Every row carries `workspace` (the access key, written at create) and
// `team_id` (routing), as ingest rows do (CLAUDE.md, Workspace access vs
// routing).

import { defineTable } from "convex/server";
import { v } from "convex/values";

const liveReader = v.union(
  v.object({ kind: v.literal("marker") }),
  v.object({ kind: v.literal("github-status"), context: v.string() }),
  v.object({ kind: v.literal("json"), url: v.string(), sha_field: v.string(), version_field: v.optional(v.string()) }),
);

export const deployTables = {
  // One repository's deploy targets as its checkout declares them
  // (contracts/deployTargets), published from the machine that holds the
  // checkout, which is where a target that runs `here` is sent from.
  deploy_targets: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    name: v.string(),
    command: v.optional(v.string()),
    runs: v.union(v.literal("here"), v.literal("push")),
    live: liveReader,
    rollback: v.optional(v.string()),
    policy: v.union(v.literal("press"), v.literal("auto")),
    paths: v.array(v.string()),
    ship_stage: v.optional(v.union(v.literal("before_push"), v.literal("after_push"), v.literal("press"))),
    // The checkout that published it and the machine it is on: where a deploy of it runs.
    device_id: v.optional(v.string()),
    root: v.optional(v.string()),
    publisher_user_id: v.id("users"),
    // What a json reader last read, so a poll records a deploy only when it changes.
    last_read: v.optional(v.object({ sha: v.optional(v.string()), version: v.optional(v.string()), at: v.number(), error: v.optional(v.string()) })),
    // A target the checkout no longer declares keeps its row (its deploys still name it) and stops showing.
    retired_at: v.optional(v.number()),
    published_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace_repository", ["workspace", "repository"])
    .index("by_repository_name", ["repository", "name"]),

  // CI on a repository's default branch, one row per commit and workflow (an
  // Actions workflow run) or app (a check suite from any other app): green,
  // red and still running, so every commit on main has a CI state.
  commit_ci: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    sha: v.string(),
    // The workflow's name, or the app's.
    name: v.string(),
    kind: v.union(v.literal("workflow"), v.literal("suite")),
    run_id: v.optional(v.string()),
    status: v.string(),
    conclusion: v.optional(v.string()),
    url: v.optional(v.string()),
    started_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_repository_sha", ["repository", "sha"])
    .index("by_repository_started", ["repository", "started_at"]),

  // One pass of `cast ship checkout` (the /deploy path): what it committed,
  // what it held back, and each deploy step's result, so a ship is visible
  // after its terminal is gone.
  ship_passes: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    user_id: v.id("users"),
    device_id: v.optional(v.string()),
    ok: v.boolean(),
    stage: v.string(),
    reason: v.optional(v.string()),
    // The upstream commit it replayed onto, and what it pushed.
    base: v.optional(v.string()),
    pushed: v.optional(v.string()),
    pr_url: v.optional(v.string()),
    commits: v.array(v.object({ sha: v.optional(v.string()), message: v.string(), files: v.number(), session_id: v.optional(v.string()), conversation_id: v.optional(v.id("conversations")) })),
    held: v.array(v.object({ group: v.string(), paths: v.number(), note: v.optional(v.string()) })),
    deploys: v.array(v.object({
      name: v.string(),
      stage: v.string(),
      ok: v.boolean(),
      target: v.optional(v.string()),
      // The deploy it recorded (dp-N), for a step that names a target.
      deploy: v.optional(v.string()),
      output: v.optional(v.string()),
    })),
    started_at: v.number(),
    finished_at: v.number(),
  })
    .index("by_workspace_finished", ["workspace", "finished_at"])
    .index("by_repository_finished", ["repository", "finished_at"]),
};
