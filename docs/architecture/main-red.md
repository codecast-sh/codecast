# Red main

When CI on a repository's default branch goes red, codecast names the commit that broke it, raises one event for that culprit, and briefs the session that wrote it. When the branch is green again it raises a second event. Code: `packages/convex/convex/mainRed.ts` (the judging), `packages/shared/contracts/mainRed.ts` (the pure rules, the payload, the brief).

## What is judged

Every finished run of CI on a push to the default branch, under four gates:

- **The repository is listed** in the convex environment variable `MAIN_RED_REPOS` (`owner/name`, comma-separated; empty by default, so nothing is judged until a repository is named). Rerunning a red run's failed jobs reruns the jobs that need them as well, so a push-only deploy job that `needs:` the tests would send an old sha out again; list a repository only once its CI has no such job.
- **The repository declares deploy targets** (`.codecast/deploy.toml`). A rerun spends the team's Actions minutes, and the wakes are for teams that ship through codecast, so a repository without targets is never judged.
- **The workflow is CI**: one that also runs on pull requests (`ci_workflows`, marked by a finished pull request run from the repository itself; a fork's pull request can add a trigger to any workflow, so it marks nothing). A push-only workflow (a release, a publish) is never rerun. A run of a deploy target's own workflow is a deploy, and is skipped too.
- **The workspace is pinned.** A workflow's first judgment pins the workspace of the oldest deploy target declaring the repository on its `ci_workflows` row (access), with that target's team (routing). It stays pinned until that workspace no longer declares a target, whatever team a webhook routes to, so one repository's runs never split between workspaces.

The workflow_run webhook claims the run (`main_ci_runs`, one row per run). A failure there is caught and the step tried once more 16 minutes later, so it never rolls back the rest of that webhook's processing; a row a failed claim left judging for over 15 minutes is judged on that retry or the next delivery. The server then reads, through the GitHub App, the run's jobs, the workflow file at the run's commit, and the failed jobs' logs. A log over 8MB is named unread. A read that throws (a token or GitHub error) is logged on the row and retried after 1 and 5 minutes; after that the run is lost.

## Identity: a culprit is the jobs it broke

A culprit is keyed by the jobs that failed, as GitHub's jobs API names them, which is complete. It is never keyed by the tests a log prints: a crash names no test, a log can be unreadable, and only some failures are kept, so a test list blames a partial fix for the failures its culprit left. Parsed failures (`shared/contracts/ciFailures.ts`, the CI station's parser, so the same `{job, test, assertion, file, line, excerpt}` shape as `ci.json`) are only the brief's content.

A failed job that needs another job that failed in the same run is an aggregate (codecast's `verify` needs every test job): it fails whenever they do, so it never joins, holds or names a culprit. Its `needs:` come from the workflow file at the run's commit. A run's job name is matched to its workflow job with its run-time suffixes taken off (a reusable workflow's `caller / callee` is `caller`, a matrix job's `name (a, b)` is `name`), or by the literal part of a `name:` template; a name that matches nothing is a job of its own, never an aggregate. When the file cannot be read, or a failed job matches no declared job, timing decides: a failed job that started only once every other job of the run had finished, passing or failing, is the aggregate.

A culprit owns its jobs while they stay red. A second break in a job a culprit already owns stays with that culprit until the job passes: a job's log can show a different test failing for many reasons (a crash names none, a truncated list shows the rest), and only the job's own verdict is complete. A re-break after the job passed is a new culprit.

## The rules

1. A run red on its first attempt has its failed jobs rerun once. A job cancelled inside a finished run counts as failed: a person can only cancel a whole run, which is no verdict, so a cancelled job is one that hit its `timeout-minutes` (an aggregate like `verify` failing behind it is no failure of its own). If the rerun is green, it was a flake: no event fires, and each failure is recorded as a `ci_flake` row (`cast events ls`) for the quarantine list (`QUARANTINE.md`).
2. If the installation has not granted `actions: write`, or GitHub refuses the rerun, the red is unproven: it names nobody alone. The next run of the workflow that runs its failed jobs decides it: jobs failed again make it a red, placed in order with `reran: false` and the refusal in the event's summary and the brief; jobs passed mean it recovered: a flake and a fix the next commit made look the same, so it is recorded as unproven and recovered, never as a flake, and never reaches the quarantine list. An unproven run no later run decides within a week is let go.
3. Reds are placed in the branch's order. A red waits while any commit before it since the last green may still get a verdict: its run here is judging, rerunning or unproven, or it has no run here yet and was pushed under 45 minutes ago. For those, GitHub is asked once whether the commit has a run of the workflow queued or going (`actions/runs?head_sha=`); if GitHub cannot be asked, each such commit counts as still going.
4. A red waits at most 45 minutes from its own verdict, then is placed with what has settled. A placement made at the deadline is never revised: if the earlier commit's run then lands red failing the same job, it only joins, and the culprit stays the later commit, inexact, with the earlier one among its candidates. The deadline keeps a lost webhook from holding a red forever.
5. A red failing a job an open culprit owns joins it: the run's commit is added to that culprit's `red_shas`, and nobody is woken again.
6. A failed job no open culprit owns is history when a later run of the workflow ran and passed it: a rerun that settles after the fix's run, or a manual rerun of an old run, fires nothing.
7. Otherwise it is a new culprit's, ranging from the oldest of its jobs' last greens to the red commit. A job's last green is the newest run of the workflow where it ran and passed; a run that skipped it (CI that runs only the jobs a commit's paths reach) says nothing about it.
8. With no last green for a job the red is a baseline: it names nobody. That is the first run ever, a branch already red when it is first judged, a last green whose commit a force-push removed, and a job run so rarely that its last green is more than the 60 newest runs of the workflow back. A red that has itself fallen out of the newest 60 (an old run rerun by hand) is still placed at its own deadline.
9. A range of one commit is exact. A longer one sets `culprit_exact` false, and `candidates` lists its commits: none of them was tested for the failing jobs. `culprit_sha` is always the red run's commit.
10. One commit that breaks two CI workflows is one culprit: the second workflow's jobs and failures join the culprit the first named, with no second event or brief.
11. A culprit's job that a later run ran and passed is fixed: the culprit no longer owns it, so a later failure of it is a new culprit, and somebody is told. Once all its jobs are fixed the culprit is fixed, and the next green run of its CI fires `main_green` with its payload, in its workspace.
12. A culprit whose jobs have not run for a week, or whose jobs left the workflow, expires with no event. A job left the workflow when a run's full job list from the jobs API, which names skipped jobs too, has no job with its key; the workflow file never decides it. Open culprits are read newest first, 50 per workspace and repository; past that the log says how many went unread.

A run whose verdict never comes is read back from GitHub 45 minutes after it was claimed: a finished later attempt is judged, a finished attempt whose judge never settled it is judged again, a run still going is waited on for up to 6 hours, and anything else (a cancelled rerun, a run GitHub cannot answer for) is lost, which holds nothing and names nobody.

## Events

`main_red` and `main_green` are trigger events (`cast trigger add --on main_red --repo owner/name`). Each also writes an `external_events` row in the pinned workspace, readable through `cast events ls`; `--json` carries the payload as `data.main_red`. The row's title holds no words a committer wrote (it reaches a trigger's run as its prompt); the subject is in the payload.

```
{ repo, branch, culprit_sha, culprit_exact, candidates[],
  culprit_subject, culprit_author, culprit_session, culprit_run, culprit_task,
  red_shas[], first_red_at, ci_run_url, reran, failing[] }
```

- `culprit_session` is the commit's `Codecast-Session` trailer, when the trailer names a session the workspace may link, as the 7-character session id `cast read` and `cast send` take.
- `culprit_run` is the change run whose merge recorded the commit (`workflow_runs.merge.sha`), as its full run id. Runs have no short id, and the full id is the only form `cast workflow show` takes that names this exact run (a task's ct-N shows its current run, which may be a later one).
- `culprit_task` is that run's task, else the first task the commit names, as its ct-N.
- `failing` holds the failures of the culprit's own jobs, never an aggregate's.
- `red_shas` grows on the culprit's row (`main_reds`) as later reds join it; the event carries it as it stood when it fired.
- Every sha is the full 40 characters.

The Release Captain acts on these events. Codecast never reverts a commit itself.

## Who is told

- When the culprit is exact, its session is sent the brief: the failures, each with file, line and excerpt. When there is no session it may tell, the commit's author, if the workspace admits them, gets a high-priority task with the same brief.
- When it is not exact and there are 5 candidates or fewer, every candidate's session it may tell is sent the brief, each told it is one of N and which commit is its own.
- With more than 5 candidates no session is briefed: each brief is an agent turn, and most would be wasted. The event still fires, and one task goes to whoever pushed the newest candidate (`commits.pushed_by`), naming the range.
- Each session or person is told at most once per culprit commit, ever: who was told is kept on the culprit row (`main_reds.briefed`), and a culprit raised again for the same commit (after its first one expired) skips them.
- A session may be told only when its owner put the commit on the branch, or the session itself recorded the sha (`commitRecordedBy`). Its owner put it there when they are the push's pusher (`commits.pushed_by`, which GitHub authenticates) or the owner of the change run whose merge recorded it. A trailer alone only links, and an author is only an email: anyone with push access may write both to name a teammate's session.
- The commit's subject and the failures sit in a fence neither can close, introduced as text from the commit and the run to read, never instructions: the culprit's own code prints the failures.
- Nobody else is woken.

`/cli/main-red/open {repository}` answers a repository's open culprits while the branch's head is red by its own judged run, and nothing while the head is green or still running: a culprit stays open until its jobs pass, so an open culprit alone does not say the branch is red now. It is read by the Deploy station's wait line (awaitDeploy's `redSinceWords`, which walks main's CI itself when the server names nothing), whose "red since" words `mainRedSince` gives: the culprit's short sha and subject, and `(N commits)` when it is not exact.

## Ops notes

- **Rerun permission.** The Codecast-sh App declares `actions: write` (GitHub's public `GET /apps/codecast-sh`, read 2026-11-21: actions write, checks read, contents write, issues write, metadata read, pull_requests write, statuses read, workflows write). Whether each installation accepted it could not be read from a laptop: listing an organization's installations needs `admin:org`, and `GET /app/installations/{id}` needs the App's key. So the server does not assume it. Each judgment reads what the installation token was granted (`getInstallationToken`'s `permissions`), and without `actions: write` it never asks for a rerun: the red is unproven (rule 2) and the brief and event say why. An installation that has not accepted the permission is visible on its row's cached token (`github_installation_tokens.permissions`).
