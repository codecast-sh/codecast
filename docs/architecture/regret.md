# Regret: which merged changes came back, and which checks let them through

A line earns the right to merge on its own by how often what it merged needed
fixing afterwards. This document defines that measure, where its facts live,
and how they are recorded. Sections are R1 onward so code can cite them.

## R1. One home: `landed_changes`

One row per commit that reached a repository's default branch, written only
by `landedChanges.record` (convex):

| Field | What it holds |
|---|---|
| `repository`, `sha`, `subject` | the commit |
| `landed_at` | its place on main: `commits.main_at` when the webhook saw the push, else its commit time |
| `conversation_id`, `run_id`, `role_id`, `via` | the session that wrote it, the run that session worked under and the role it worked for, as the blame resolver finds them (`blame.resolveCommitSessions`: the Codecast-Session trailer, a commits row, a stored hash, subject and time), resolved once when the row is written |
| `fix_reason` | set when the commit is itself a fix: a bug task, a fix story, or a subject starting `fix:` / `fix(` (`lineFixloop.selectFixCommits`) |
| `fixed_by` | every traced fix that changed this commit's lines: the fix's sha, its `landed_at`, how many of this commit's lines it changed |

A fix's trace is the SZZ trace `cast line fixloop` already runs: the lines the
fix removed or rewrote, blamed at the fix's parent revision. Each introducing
commit's row gains the fix in `fixed_by`. An introducing commit older than any
recorded row gets a row of its own, so a link is never dropped.

## R2. The nightly record

At 03:30 UTC `landedChanges.nightly` (crons.ts) queues `line_fixloop` at every
machine that publishes a team's line profile, one command per team and
machine naming the checkouts its profiles publish from. That daemon runs
`cast line fixloop --record --team <id> --from <checkouts>`, which:

1. reads each checkout's origin only, to name the repository;
2. fetches the default branch into this machine's own bare mirror,
   `~/.codecast/mirrors/<owner>__<name>.git`, and reads history there and
   nowhere else, so a checkout that is behind main or holds other sessions'
   edits changes nothing;
3. sends every commit on main since three days before the newest recorded one
   (60 days on the first run), then every fix with the commits it traced to.

Re-sending the overlap is harmless: a commit has one row, and a fix is added
to a row's `fixed_by` once.

## R3. A change, and when it is regretted

A change is one commit that landed on main. How it got there is one of three
buckets (`through`):

- **line**: it came through a run a role started (`workflow_runs.org_role_id`):
  the run's merge commit, or a commit whose session worked under the run.
- **session_flow**: it came through a check flow a person's session ran (a
  graph run from the pool: `change`, `quick-change`, `onefix`, `agentwatch`
  and the like) that no role started.
- **outside**: anything else. No run, a Claude Code workflow run
  (`run_kind: "workflow"`, which checks nothing) and the sessions under it,
  or a commit no session claims.

The role is the run's role for a line change; otherwise the role the
change's session worked for, if any.

- **Top introducer.** A fix's links name every commit whose lines it
  changed. Only the commit that gave the fix the most lines counts, and ties
  all count. Each link stores `lines` and the fix's `top`, so the rule can
  change without a new trace.
- **Live.** The first live deploy in the workspace that holds the change. A
  placed deploy (`cut_at`) holds what reached main at or before its cut; an
  unplaced one holds what landed before it went live (deploys.md DP3).
- **Window.** Measured from the data (`windowFromLags`). Take the lag from a
  change going live (else landing) to each top fix that traced to it, over
  the read range. The window is long enough to cover three quarters of those
  lags, at most 30 days, and 14 days when there is none. A caller may set it
  instead.
- **Regretted.** A fix it was the top introducer of landed after it and
  before its window closed, or its run's problem reopened in watch (a signal
  with `reopened`) in that span.
- **Settled.** Regretted, or its window has closed. A change whose window is
  still open and that has not come back is **partial**, counted apart.

The **regret-free merge rate** of a role, flow and bucket is
`(settled - regretted) / settled` over the changes that landed in the last 60
days. No settled changes, no rate.

## R4. A check's miss rate

A check station is a station of the check phase (`linePhases.guessPhase`:
check, eval, review, verify and the like) that a change's run passed: it
completed with outcome success. The blind judge (`<node>__judge`) passed when
the run went out through `<node>__low`. A station's **miss rate** is
`regretted / settled` over the changes it passed.

## R5. What the rate does not see

- SZZ over-attributes: a fix that rewrote a line names the commit that wrote
  the line, which may not be the cause. Counting only the top introducer
  keeps a rewrite from blaming every commit it touched. The weekly fix-loop routine confirms
  causes by reading both diffs and files `szz:<sha>` signals; the rate counts
  every trace, confirmed or not.
- A fix commit nobody marked (no bug task, no fix story, no `fix` subject) is
  invisible.
- A change outside any run has no checks to credit or blame.

## R6. Where it is read

`landedChanges.summary({ team_id, window_days? })` returns the window and
how many links it was measured from, and per role, flow and bucket `merged`, `settled`, `regretted`, `partial` and `rate`, and per check
station `passed`, `settled`, `regretted` and `miss_rate`
(`shared/contracts/regretRates.ts` does the counting). The role's merge
setting reads the same answer for its line changes (`roleLineRate`).

## R7. Merging on the measured rate

The role's merge step decides one of two ways (`org_roles.line_merge_rate`):

- **Count** (the default, and every role's setting until a person changes it):
  the switch, the role's merge grant and its daily limit, as the-line.md L12
  says.
- **Rate**: everything Count requires, and the role's measured regret-free
  rate over its line changes (`roleLineRate`: bucket `line`, its runs) holds
  the bar a person set (`bar`, a share) over at least `min` settled changes.
  The daily limit stays as a backstop. Below the bar, short of the minimum,
  or with no rate readable, the step does not merge and says which.

`lib/regretRead.roleMergeAllowance` is the one reading: the merge step's
check and record (`orgLineMerge`), Ship's facts (`ship.ts`) and the role's
settings (`orgRoles.line`) all go through it. The rate is read when the role
merges on it, and always for the settings, which show it beside the control.

Only a person sets the mode, from the role's settings, through the shared
confirm review (`mergeRateLedger`): `orgLineMerge.setLineMerge` refuses a
`rate` sent with an API token or from a session. The switch itself keeps its
own rule (an admin, from anywhere). Each change of mode is logged in
`org_role_history` (`field: line_merge_rate`).
