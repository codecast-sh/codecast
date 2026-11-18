// Environment attempts and links (shared/contracts/envs.ts; pl-1049
// ct-96178). An attempt is one runner result filed under the env it ran; a
// link is a measured relation between an env and the level above it, kept
// with its evidence and age. A goal names its envs on the initiative row
// (`initiatives.envs`, goalEnvValidator); the envs themselves are declared in
// the product repo, so no table holds them.
//
// Every row carries `workspace` (the access key) and an optional `team_id`
// for routing; reads compare `workspace` only.
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { ENV_LEVELS, ENV_SPLITS } from "@codecast/shared/contracts/envs";

const literals = <T extends string>(values: readonly T[]) => v.union(...values.map((value) => v.literal(value)));

export const envLevelValidator = literals(ENV_LEVELS);
export const envSplitValidator = literals(ENV_SPLITS);
export const goalEnvValidator = v.object({ env: v.string(), level: envLevelValidator, note: v.optional(v.string()) });
const interval = v.array(v.number());

export const envTables = {
  env_attempts: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    short_id: v.string(),
    env: v.string(),
    env_version: v.string(),
    level: envLevelValidator,
    title: v.optional(v.string()),
    // Where the declaration lives (a normalized git remote): one key, one repo.
    repo: v.optional(v.string()),
    candidate: v.object({ label: v.string(), sha: v.optional(v.string()), prompt_hash: v.optional(v.string()) }),
    split: envSplitValidator,
    n: v.number(),
    mean: v.number(),
    ci95: v.optional(interval),
    unscored: v.optional(v.number()),
    baseline: v.optional(v.object({ label: v.string(), mean: v.number() })),
    paired_delta: v.optional(v.number()),
    paired_ci95: v.optional(interval),
    noise: v.optional(v.object({ aa_sd: v.number(), aa_runs: v.number() })),
    cost_usd: v.optional(v.number()),
    started_at: v.number(),
    finished_at: v.number(),
    by_user: v.id("users"),
    session_id: v.optional(v.string()),
    task_id: v.optional(v.string()),
    goal_id: v.optional(v.id("initiatives")),
    created_at: v.number(),
  })
    .index("by_short_id", ["short_id"])
    .index("by_workspace_env", ["workspace", "env", "finished_at"])
    .index("by_workspace", ["workspace", "finished_at"]),

  // An attempt's cases, apart from the attempt so a standing or a list never
  // reads them: CompactCase[] as JSON, [id, score, draws?, pass?, note?]; a
  // held run's are [id, score]. One row per attempt.
  env_attempt_cases: defineTable({
    attempt_id: v.id("env_attempts"),
    workspace: v.string(),
    cases: v.string(),
  }).index("by_attempt", ["attempt_id"]),

  env_links: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    env: v.string(),
    to: v.string(),
    measure: v.string(),
    value: v.number(),
    n: v.number(),
    measured_at: v.number(),
    // What shows it: an attempt (ea-N), a doc, a session, a link.
    evidence: v.optional(v.string()),
    by_user: v.id("users"),
    created_at: v.number(),
  }).index("by_workspace_env", ["workspace", "env", "measured_at"]),
};
