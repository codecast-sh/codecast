// Tables for bringing moments (docs/architecture/learning-loop.md LL7 to
// LL10): the moment each coalesced event becomes, the extractors and judges a
// product's repo publishes, each judge's run on a moment (that step's
// decision), the vectors grouping compares findings by, and each team's model
// budget.
//
// Every row carries `workspace` (the access key) and, where it routes, an
// optional `team_id`, as ingest rows do (CLAUDE.md, Workspace access vs
// routing). Moment bodies never live in a row: they are kept on the
// extractor's host or, when a person chose codecast storage, in R2.

import { defineTable } from "convex/server";
import { v } from "convex/values";

/** The embedding grouping compares by (lib/embeddings.ts): OpenAI text-embedding-3-small. */
export const FINDING_VECTOR_DIMENSIONS = 1536;

/** What a judge run read, as hashes: the messages (what was said) and the facts and text the extractor computed (lib/momentJudging.judgeInputsOf). */
export const judgeInputs = v.object({ messages: v.string(), facts: v.string() });

/** An agent judge's session (contracts/agentJudges AgentJudgeSpec), with the files its header names read in at publish. */
export const agentJudgeFields = v.object({
  tools: v.array(v.string()),
  cwd: v.string(),
  max_turns: v.number(),
  timeout_ms: v.number(),
  /** The text installed as the session's user-level CLAUDE.md. */
  claude_md: v.optional(v.string()),
  /** The gateway script, relative to the repo root, the reviewing machine starts. */
  gateway: v.optional(v.string()),
});

export const agentReviewStatus = v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed"), v.literal("cancelled"));

const momentStatus = v.union(v.literal("waiting"), v.literal("extracting"), v.literal("ready"), v.literal("failed"));
const budgetPurposes = v.object({ judge: v.number(), grouping: v.number(), call: v.number() });

export const momentsTables = {
  // LL7. One moment: the coalesced events of one (kind, subject), then what
  // the extractor returned. `waiting` absorbs newer events until due_at (the
  // kind's quiet window after the newest); `extracting` is leased to the host
  // until due_at; `ready` has its body where `storage` says.
  moments: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    source_id: v.id("event_sources"),
    project_id: v.optional(v.id("projects")),
    short_id: v.string(), // "mo-N"
    kind: v.string(),
    subject: v.string(),
    status: momentStatus,
    /** Events coalesced into it, and the first and newest event times. */
    events: v.number(),
    first_event_at: v.number(),
    event_at: v.number(),
    /** The newest event's refs, as JSON (product keys are not Convex field names). */
    refs_json: v.optional(v.string()),
    /** waiting: when it may be extracted. extracting: when the host's lease ends. */
    due_at: v.number(),
    claim_device: v.optional(v.string()),
    attempts: v.number(),
    /** The extractor file's git blob sha that produced it. */
    extractor_version: v.optional(v.string()),
    extracted_at: v.optional(v.number()),
    /** Who it is about, as a list names it (contracts/moments momentWho): the extractor's own `who`, else its body's person facts. */
    who: v.optional(v.string()),
    /** extracted_at minus event_at. */
    gap_ms: v.optional(v.number()),
    storage: v.optional(v.union(v.literal("host"), v.literal("codecast"))),
    /** R2 key in the replays bucket, while the body is kept (body_expires_at). */
    body_key: v.optional(v.string()),
    body_bytes: v.optional(v.number()),
    body_expires_at: v.optional(v.number()),
    blocks: v.optional(v.number()),
    error: v.optional(v.string()),
    judged_at: v.optional(v.number()),
    /** The bulk start that opened it (`cast line reviews start --batch`), carried to its agent reviews. */
    batch: v.optional(v.string()),
    /** Lines a pending re-read was scoped to (`retry --again --lines`): the next judging grades all, files and lets go only these. */
    rejudge_lines: v.optional(v.array(v.string())),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_source_kind_subject_status", ["source_id", "kind", "subject", "status"])
    .index("by_source_kind_status_due", ["source_id", "kind", "status", "due_at"])
    // The daily prune: waiting moments no extractor ever took, and failed ones.
    .index("by_status_due", ["status", "due_at"])
    .index("by_workspace_created", ["workspace", "created_at"])
    .index("by_body_expires", ["body_expires_at"])
    .index("by_short_id", ["short_id"]),

  // LL7. A product's extractor for one moment kind, as its repo published it:
  // .codecast/moments/<kind>.ts, run on the publishing machine.
  moment_extractors: defineTable({
    workspace: v.string(),
    source_id: v.id("event_sources"),
    kind: v.string(),
    /** The file, relative to root. */
    path: v.string(),
    version: v.string(),
    quiet_ms: v.number(),
    timeout_ms: v.number(),
    /** The machine that runs it, and the checkout it runs in. */
    device_id: v.string(),
    root: v.string(),
    publisher_user_id: v.id("users"),
    published_at: v.number(),
  })
    .index("by_source_kind", ["source_id", "kind"])
    .index("by_device", ["device_id"]),

  // LL8. A codecast judge as its repo published it: .codecast/judges/<name>.md.
  judges: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    source_id: v.id("event_sources"),
    name: v.string(),
    version: v.string(),
    path: v.string(),
    moment_kind: v.string(),
    model: v.string(),
    max_tokens: v.number(),
    /** As the header names them, and as resolved in the workspace. */
    projects: v.array(v.string()),
    project_ids: v.array(v.id("projects")),
    /** The expectation parts it grades (its header's `parts`); every part when absent. */
    parts: v.optional(v.array(v.string())),
    mode: v.union(v.literal("shadow"), v.literal("live")),
    prompt: v.string(),
    /** Set for an agent judge: its reviews queue (agent_reviews) and run as sessions on machines. */
    agent: v.optional(agentJudgeFields),
    publisher_user_id: v.id("users"),
    published_at: v.number(),
    /** Set when a publish no longer carries the file; a removed judge runs no more. */
    removed_at: v.optional(v.number()),
  })
    .index("by_source_kind", ["source_id", "moment_kind"])
    .index("by_source_name", ["source_id", "name"]),

  // LL8. One judge's run on one moment: the judge step's decision. Its
  // findings are kept here whatever the mode; a live judge also files them.
  judge_runs: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    source_id: v.id("event_sources"),
    judge_id: v.id("judges"),
    judge: v.string(),
    judge_version: v.string(),
    moment_id: v.id("moments"),
    moment_short_id: v.string(),
    mode: v.union(v.literal("shadow"), v.literal("live")),
    status: v.union(v.literal("ok"), v.literal("failed"), v.literal("skipped")),
    /** Why it failed or was skipped, in words. */
    reason: v.optional(v.string()),
    /** The expectations versions it graded against. */
    expectations: v.array(v.object({ project_id: v.id("projects"), version: v.number() })),
    /** JudgeFinding[] as JSON. */
    findings_json: v.optional(v.string()),
    findings: v.number(),
    uncited: v.optional(v.number()),
    signal_ids: v.optional(v.array(v.id("signals"))),
    /** Findings already on the board that this run found again unchanged: it stands behind them without filing them (judgeRetire.settleRun). */
    held_ids: v.optional(v.array(v.id("signals"))),
    /** Evidence keys it found and did not file, being one resample (judgeRetire.newOnResample): a read that found a key counts as a find when a later read weighs its misses. */
    waiting: v.optional(v.array(v.string())),
    /** Hashes of what it read (lib/momentJudging.judgeInputsOf): a later miss lets a finding go at once only when these or the judge changed (judgeRetire.settleRun). */
    inputs: v.optional(judgeInputs),
    /** Lines it filed and let go under, when scoped (`--lines`); absent for a run over every line. */
    lines: v.optional(v.array(v.string())),
    model: v.string(),
    /** Where the call ran when not the API: subscription, on the Claude Code login of the machine that handed it in (charged no budget). */
    backend: v.optional(v.literal("subscription")),
    cost_usd: v.number(),
    at: v.number(),
  })
    .index("by_moment", ["moment_id"])
    .index("by_judge_at", ["judge_id", "at"])
    .index("by_workspace_at", ["workspace", "at"]),

  // LL8. One agent judge's review of one moment, from queued to settled. A
  // machine running reviews claims queued ones (agentReviews.claim), runs each
  // as a Claude Code session on a subscription login, and hands the result
  // back; the settled review's judge_runs row is `run_id`, and the session's
  // transcript is kept in R2 under `transcript_key` for a person to open.
  agent_reviews: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    source_id: v.id("event_sources"),
    judge_id: v.id("judges"),
    judge: v.string(),
    judge_version: v.string(),
    moment_id: v.id("moments"),
    moment_short_id: v.string(),
    subject: v.string(),
    short_id: v.string(), // "rv-N"
    status: agentReviewStatus,
    /** Who asked: the moment's judging, or a person's bulk start (its batch label). */
    batch: v.optional(v.string()),
    attempts: v.number(),
    /** running: the machine and the saved profile it runs on, and when its lease ends. */
    claim_device: v.optional(v.string()),
    account: v.optional(v.string()),
    lease_until: v.optional(v.number()),
    started_at: v.optional(v.number()),
    finished_at: v.optional(v.number()),
    /** What the session took: wall time, turns, tokens, and what claude reports it would cost on the API (subscription quota, not money). */
    took_ms: v.optional(v.number()),
    turns: v.optional(v.number()),
    usage: v.optional(v.object({ input: v.number(), output: v.number(), cache_read: v.number(), cache_write: v.number() })),
    notional_usd: v.optional(v.number()),
    /** Of notional_usd, what the second turn (listing the findings) cost. */
    findings_turn_usd: v.optional(v.number()),
    /** Set once correctDoubledCosts fixed a cost that counted the first turn twice. */
    cost_corrected: v.optional(v.boolean()),
    findings: v.optional(v.number()),
    filed: v.optional(v.number()),
    run_id: v.optional(v.id("judge_runs")),
    transcript_key: v.optional(v.string()),
    transcript_bytes: v.optional(v.number()),
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_status_created", ["status", "created_at"])
    .index("by_source_status", ["source_id", "status"])
    .index("by_moment", ["moment_id"])
    .index("by_judge_created", ["judge_id", "created_at"])
    .index("by_short_id", ["short_id"]),

  // LL9. What a finding said happened, embedded, so a new finding can be
  // grouped with the problem whose findings read the same. Kept off the
  // signals row: Convex reads whole documents. `scope` is workspace|subject,
  // since a vector filter is one equality.
  signal_vectors: defineTable({
    workspace: v.string(),
    scope: v.string(),
    signal_id: v.id("signals"),
    embedding: v.array(v.float64()),
  })
    .index("by_signal", ["signal_id"])
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: FINDING_VECTOR_DIMENSIONS, filterFields: ["scope"] }),

  // LL10. A team's monthly model budget: the cap a person set, and this
  // month's spend by purpose. 0 is off.
  team_budgets: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    cap_usd: v.number(),
    month: v.string(),
    spent_usd: v.number(),
    held_usd: v.number(),
    /** When a hold was last granted: a full cap with none granted for longer than any call runs holds only leftovers. */
    last_granted_at: v.optional(v.number()),
    by_purpose: budgetPurposes,
    refused: v.number(),
    last_refused_at: v.optional(v.number()),
    history: v.array(v.object({ month: v.string(), spent_usd: v.number() })),
    set_by: v.optional(v.id("users")),
    set_at: v.optional(v.number()),
    updated_at: v.number(),
  }).index("by_workspace", ["workspace"]),

  // LL10. What one project's model calls cost in one hour, by purpose: the
  // budget's spend split by the project each call served, written where every
  // call settles (modelCalls.withinBudget), so a project (a trial) reads its
  // own model spend. `project_id` absent: calls that served no one project.
  // A call that served several splits its cost evenly among them.
  model_spend_hours: defineTable({
    workspace: v.string(),
    project_id: v.optional(v.id("projects")),
    hour: v.number(),
    usd: v.number(),
    calls: v.number(),
    by_purpose: budgetPurposes,
  })
    .index("by_project_hour", ["project_id", "hour"])
    .index("by_workspace_hour", ["workspace", "hour"]),
};
