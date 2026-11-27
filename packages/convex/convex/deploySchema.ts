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
import { roleIconAccentValidator, roleIconValidator } from "./lib/roleIconValidator";

const liveReader = v.union(
  v.object({ kind: v.literal("marker") }),
  v.object({ kind: v.literal("github-status"), context: v.string() }),
  v.object({ kind: v.literal("json"), url: v.string(), sha_field: v.string(), version_field: v.optional(v.string()) }),
);

const nullableString = v.union(v.string(), v.null());

// One failure read out of a CI job's log (shared/contracts/ciFailures.ts).
const ciFailureValidator = v.object({
  job: v.string(),
  test: nullableString,
  assertion: nullableString,
  file: nullableString,
  line: v.union(v.number(), v.null()),
  excerpt: v.string(),
});

/** One job of our own CI runner's verdict on a commit (`cast ci record`): failing tests in CiFailure's shape. */
export const runnerJob = v.object({
  name: v.string(),
  counts: v.boolean(),
  conclusion: v.string(),
  seconds: v.number(),
  failing: v.array(ciFailureValidator),
  log_storage_id: v.optional(v.id("_storage")),
  note: v.optional(v.string()),
});

// The main_red / main_green payload (shared/contracts/mainRed.ts MainRedPayload).
export const mainRedPayloadValidator = v.object({
  repo: v.string(),
  branch: v.string(),
  culprit_sha: v.string(),
  culprit_exact: v.boolean(),
  candidates: v.array(v.string()),
  culprit_subject: nullableString,
  culprit_author: nullableString,
  culprit_session: nullableString,
  culprit_run: nullableString,
  culprit_task: nullableString,
  red_shas: v.array(v.string()),
  first_red_at: v.number(),
  ci_run_url: nullableString,
  reran: v.boolean(),
  failing: v.array(ciFailureValidator),
});

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
    policy: v.union(v.literal("press"), v.literal("release"), v.literal("auto")),
    paths: v.array(v.string()),
    // Paths under `paths` that ship nothing here (tests): a commit of only these waits on no deploy of it (fileShipsTo).
    // A publish from a CLI that does not read the key clears it, so the target counts every path under `paths` again.
    unless: v.optional(v.array(v.string())),
    ship_stage: v.optional(v.union(v.literal("before_push"), v.literal("after_push"), v.literal("press"))),
    // The Actions workflow file its deploys run as (deploy.yml): each run on the default branch records a deploy.
    workflow: v.optional(v.string()),
    // The inputs a rollback adds to `sha` and `actor` when codecast dispatches `workflow` (Union's components).
    rollback_inputs: v.optional(v.record(v.string(), v.string())),
    // The CI workflow file whose pass on main makes a commit green (ci.yml): a rollback's pause waits for it.
    ci_workflow: v.optional(v.string()),
    // The checkout that published it and the machine it is on: where a deploy of it runs.
    device_id: v.optional(v.string()),
    root: v.optional(v.string()),
    publisher_user_id: v.id("users"),
    // The commit the publishing checkout was at, and when it was made: a publish from an older commit is refused, so
    // a stale clone or a feature worktree never puts back a target main no longer declares.
    head_sha: v.optional(v.string()),
    head_at: v.optional(v.number()),
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
    // runner: our own CI runner's verdict (`cast ci record`, ct-102083). Deploy, rollback and red-main decisions
    // read it only once `ciRowDecides` says so (shared/contracts/deployTargets.ts); in shadow it decides nothing.
    kind: v.union(v.literal("workflow"), v.literal("suite"), v.literal("runner")),
    run_id: v.optional(v.string()),
    // A runner row's host, run kind (main's shadow run or a landing candidate's) and per-job verdicts, each job's
    // log a gzipped tail in file storage.
    host: v.optional(v.string()),
    run_kind: v.optional(v.union(v.literal("main"), v.literal("landing"))),
    jobs: v.optional(v.array(runnerJob)),
    // A workflow run's file (`.github/workflows/ci.yml`), so a reader can ask for one workflow's verdict.
    path: v.optional(v.string()),
    status: v.string(),
    conclusion: v.optional(v.string()),
    url: v.optional(v.string()),
    started_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_repository_sha", ["repository", "sha"]),

  // A repository's production paused (deploys.md DP17): nothing is sent to its targets while one stands, except
  // the rollback that paused it. Who paused and why, and what ends it: a commit green on main (a rollback's
  // revert or fix forward, filed to the Release Captain as `task_id`), or nothing, when a person or the Release
  // Captain lifts it. At most one stands per repository; a lifted row is kept as the record.
  deploy_pauses: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    by: v.object({
      kind: v.union(v.literal("person"), v.literal("role")),
      name: v.string(),
      user_id: v.id("users"),
      role_id: v.optional(v.id("org_roles")),
    }),
    reason: v.string(),
    // The rollback (dp-N) that paused it, and the commit that ends it: the first commit on main after `from_sha` that
    // names `task_id`, once it (or a later commit) passes CI.
    rollback: v.optional(v.string()),
    until: v.optional(v.object({
      task_id: v.id("tasks"),
      kind: v.union(v.literal("revert"), v.literal("fix_forward")),
      from_sha: v.string(),
      // The commits the rollback took off production, and the migration files among them.
      shas: v.array(v.string()),
      migrations: v.array(v.string()),
    })),
    created_at: v.number(),
    reminded_at: v.optional(v.number()),
    lifted_at: v.optional(v.number()),
    lifted_by: v.optional(v.string()),
    // The commit whose green CI lifted it.
    lifted_on: v.optional(v.string()),
  })
    .index("by_workspace_repository_lifted", ["workspace", "repository", "lifted_at"])
    .index("by_lifted", ["lifted_at"]),

  // A workflow that runs on pull requests as well as pushes: CI, which red
  // main judges. A push-only workflow (a release, a publish) is never rerun.
  // `workspace` and `team_id` pin where its runs are judged: set on its first
  // judgment from a deploy target declaring the repository, and kept until
  // that workspace no longer declares one.
  ci_workflows: defineTable({
    repository: v.string(),
    // The workflow file, as GitHub reports it (`.github/workflows/ci.yml`).
    path: v.string(),
    seen_at: v.number(),
    workspace: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
  })
    .index("by_repository_path", ["repository", "path"]),

  // One CI run on a repository's default branch as red main judges it
  // (docs/architecture/main-red.md), in its pinned workspace: rerunning after
  // its first red attempt, unproven when GitHub refused that rerun, then green
  // or red with the jobs that ran and the jobs that failed of their own accord,
  // recovered when the next run passed what an unproven run failed, or lost when
  // no verdict ever came. `seq` is its commit's place in the branch's order
  // (commits.main_at). `failing` (the parsed failures, for a brief) is kept
  // only while a verdict waits on it.
  main_ci_runs: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    branch: v.string(),
    workflow: v.string(),
    // The workflow file (`.github/workflows/ci.yml`): what a candidate commit's runs are matched on.
    path: v.string(),
    run_id: v.string(),
    attempt: v.number(),
    sha: v.string(),
    seq: v.number(),
    url: v.optional(v.string()),
    state: v.union(v.literal("judging"), v.literal("rerunning"), v.literal("unproven"), v.literal("green"), v.literal("red"), v.literal("recovered"), v.literal("lost")),
    // Every job that ran (the jobs API), and whether it passed.
    jobs: v.array(v.object({ name: v.string(), ok: v.boolean() })),
    // The failed jobs that are not aggregates of other failed jobs: a culprit's identity.
    failed: v.array(v.string()),
    failing: v.array(ciFailureValidator),
    reran: v.optional(v.boolean()),
    // Why GitHub would not rerun the failed jobs: the run waits for the next run of those jobs.
    rerun_refused: v.optional(v.string()),
    // A red not yet placed: it waits for the runs before it to settle, until this plus the hold deadline.
    held_since: v.optional(v.number()),
    // A held red's question to GitHub: which candidate commits with no run here yet still have one going.
    candidates_probe: v.optional(v.object({ at: v.number(), answered: v.boolean(), failed: v.boolean(), pending: v.array(v.string()) })),
    // Why reading the run from GitHub last failed (judge retries twice before the run is lost).
    judge_error: v.optional(v.string()),
    at: v.number(),
    updated_at: v.number(),
  })
    .index("by_repository_run", ["repository", "run_id"])
    .index("by_scope_seq", ["workspace", "repository", "workflow", "seq"]),

  // One culprit of red main: the main_red event's payload and the jobs it
  // still owns. Red while it owns a failing job; fixed once each of its jobs
  // ran and passed (a later failure of one is a new culprit); green when the
  // branch's CI is next green (main_green); expired, with no event, when its
  // jobs stop running or leave the workflow file.
  main_reds: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    payload: mainRedPayloadValidator,
    jobs: v.array(v.object({ workflow: v.string(), job: v.string() })),
    newest_red_seq: v.number(),
    status: v.union(v.literal("red"), v.literal("fixed"), v.literal("green"), v.literal("expired")),
    // When a run last ran one of its jobs.
    seen_at: v.number(),
    // Who was told of this culprit commit: a conversation id, or `task:<user id>`. Any later culprit row for the
    // same commit reads these, so nobody is told twice of one commit.
    briefed: v.optional(v.array(v.string())),
    green_sha: v.optional(v.string()),
    green_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_repository_status", ["repository", "status"])
    .index("by_scope_status_created", ["workspace", "repository", "status", "created_at"])
    .index("by_scope_culprit", ["workspace", "repository", "payload.culprit_sha"]),

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
    .index("by_workspace_finished", ["workspace", "finished_at"]),

  // One repository's pipeline (docs/architecture/pipeline.md PL6;
  // contracts/pipeline.ts): its change and release flows as its checkout
  // resolves them, published beside its deploy targets from the same machine.
  // One row per workspace and repository, replaced whole on each publish.
  pipelines: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    // PipelineFlow, and PipelineFlow & { targets }: derived from the checkout, drawn as sent.
    change: v.any(),
    release: v.any(),
    device_id: v.optional(v.string()),
    // The commit it was built from and when that commit was made: a publish from an older commit is refused.
    head_sha: v.optional(v.string()),
    head_at: v.optional(v.number()),
    // The checkout's path on device_id's machine, and the default branch's last commits with their paths.
    root: v.optional(v.string()),
    recent: v.optional(v.object({ paths: v.array(v.string()), commits: v.array(v.object({ sha: v.string(), subject: v.string(), at: v.number(), files: v.array(v.number()) })), dropped: v.number() })),
    // A hash of what was published, so a republish of the same files writes nothing.
    hash: v.string(),
    publisher_user_id: v.id("users"),
    published_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace_repository", ["workspace", "repository"]),

  // One checkout of a repository on one device (contracts/checkouts.ts,
  // ct-98780): where it stands against origin's default branch, its
  // uncommitted work by session, and the level sweep's state on it, as the
  // device's daemon last reported it (on change only). Keyed by device and path;
  // `workspace` is the repository's team, else the reporter's own.
  checkouts: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    device_id: v.string(),
    path: v.string(),
    // CheckoutReport less repository, device_id and path: drawn as sent.
    report: v.any(),
    hash: v.string(),
    // The device's name as its owner set it, so the page names the machine.
    device_label: v.optional(v.string()),
    reporter_user_id: v.id("users"),
    reported_at: v.number(),
    updated_at: v.number(),
    // Asks a person made from the pipeline page on a stuck checkout (checkouts.ask): contracts/checkouts CheckoutPageAsk.
    // A report never writes them; the page reads them as told while the episode they were made in lasts.
    asks: v.optional(v.array(v.object({
      at: v.number(),
      since: v.number(),
      files: v.number(),
      to: v.union(v.literal("session"), v.literal("finding")),
      conversation_id: v.optional(v.string()),
    }))),
  })
    .index("by_device_path", ["device_id", "path"])
    .index("by_workspace_repository", ["workspace", "repository"]),

  // Who is sending a repository's before-merge deploys and landing them now
  // (repoLeases.ts): a Merge station or `cast ship checkout`, on any machine.
  // One row per repository; a holder renews it while it works, and a row past
  // `expires_at` holds nothing.
  repo_leases: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    token: v.string(),
    holder: v.string(),
    holder_user_id: v.id("users"),
    acquired_at: v.number(),
    expires_at: v.number(),
  })
    .index("by_repository", ["repository"])
    .index("by_workspace_repository", ["workspace", "repository"]),

  // A repository's drawn face in one workspace (repoIcons.ts): the role icon
  // language, drawn from the repository's name the first time a face asks.
  // `requested_at` holds off the next ask while a drawing runs or after one
  // failed. `accent` is picked at the first ask and the drawing wears it, so
  // the tile keeps its color when the drawing lands.
  repo_icons: defineTable({
    workspace: v.string(),
    repository: v.string(),
    accent: v.optional(roleIconAccentValidator),
    icon: v.optional(roleIconValidator),
    requested_at: v.optional(v.number()),
  }).index("by_workspace_repository", ["workspace", "repository"]),
};
