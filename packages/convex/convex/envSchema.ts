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
import { CASE_SET_SPLITS } from "@codecast/shared/contracts/envCases";

const literals = <T extends string>(values: readonly T[]) => v.union(...values.map((value) => v.literal(value)));

export const envLevelValidator = literals(ENV_LEVELS);
export const envSplitValidator = literals(ENV_SPLITS);
export const caseSetSplitValidator = literals(CASE_SET_SPLITS);
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
    /** The case set the attempt ran on, when codecast supplied it (env_heldout.version). */
    cases_version: v.optional(v.string()),
    /** The same, as held attempts filed before dev sets were recorded: read-only, never written. */
    held_version: v.optional(v.string()),
    // Filing in pages (contracts/envs compactCasePages): the client's key for
    // this filing, so a retried record answers with the attempt it made; one
    // fingerprint per page of cases; and how many pages are written.
    client_key: v.optional(v.string()),
    case_pages: v.optional(v.array(v.string())),
    case_pages_written: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_short_id", ["short_id"])
    .index("by_workspace_env", ["workspace", "env", "finished_at"])
    .index("by_workspace", ["workspace", "finished_at"])
    .index("by_client_key", ["client_key"]),

  // An attempt's cases, apart from the attempt so a standing or a list never
  // reads them: CompactCase[] as JSON, [id, score, draws?, pass?, note?]; a
  // held run's are [id, score]. One row per page (seq from 0); a row without
  // seq is an attempt filed whole, before pages.
  env_attempt_cases: defineTable({
    attempt_id: v.id("env_attempts"),
    workspace: v.string(),
    seq: v.optional(v.number()),
    cases: v.string(),
  }).index("by_attempt", ["attempt_id"]),

  // An env's case set for one split (envCases.ts, contracts/envCases.ts); the
  // tables keep their first name, from when they held only held sets, and a
  // row with no split is a held set. The newest committed set per workspace,
  // env and split is live. Its cases sit
  // apart, one row each, and leave only through a fetch (env_heldout_reads);
  // a held set's fetch only through a held run.
  env_heldout: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    env: v.string(),
    split: v.optional(caseSetSplitValidator),
    version: v.string(),
    label: v.optional(v.string()),
    /** Opaque to codecast, handed to the runner beside the cases (a split seed, a calibration). */
    meta: v.optional(v.string()),
    size: v.number(),
    /** Cases written so far; the set is live once it equals size. */
    written: v.number(),
    committed_at: v.optional(v.number()),
    by_user: v.id("users"),
    session_id: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_workspace_env", ["workspace", "env", "created_at"]),

  env_heldout_cases: defineTable({
    set_id: v.id("env_heldout"),
    workspace: v.string(),
    idx: v.number(),
    case_id: v.string(),
    payload: v.string(),
  }).index("by_set", ["set_id", "idx"]),

  // The access log: one row per upload and per run's fetch. A fetch row also
  // opens the set's pages to its caller until expires_at.
  env_heldout_reads: defineTable({
    workspace: v.string(),
    env: v.string(),
    set_id: v.id("env_heldout"),
    split: v.optional(caseSetSplitValidator),
    version: v.string(),
    kind: v.union(v.literal("put"), v.literal("run")),
    by_user: v.id("users"),
    session_id: v.optional(v.string()),
    task_id: v.optional(v.string()),
    at: v.number(),
    expires_at: v.optional(v.number()),
    /** The attempt this fetch's run filed (envs.record cases_read). */
    attempt_id: v.optional(v.id("env_attempts")),
  })
    .index("by_workspace_env", ["workspace", "env", "at"])
    .index("by_session_env", ["session_id", "env"])
    .index("by_set", ["set_id", "at"]),

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
