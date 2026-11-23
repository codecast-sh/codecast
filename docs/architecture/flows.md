# Flows: a shared pool of structured ways to run a change

Sources and flows belong to the team; a project is a home for problems
(the-line-model.md LM1). The line (`the-line.md`, `the-line-end-to-end.md`) turns findings into fixed,
watched problems. Most changes do not start as a finding: a person or an agent
in an ordinary session writes them. This document makes both kinds run through
the same structured flows, drawn from one pool, so every change goes through a
process people and agents can see. Sections are FL0 onward so code can cite
them.

## FL0. A flow, and who owns it

A flow is four things: its steps (the graph a run walks), what it takes in
(the finders and projects that feed it), an on switch, and who decides at the
end. A flow that starts work by itself has an owner: the role that leads its
projects. The owner answers the flow's asks first and recommends on its cards,
through the role ladder every decision climbs (`sessionDecisions.routeFor`).

An owned flow is derived from its owner role, never stored on its own
(`web/lib/line/ownedFlows.ts`):

| Part | Where it lives |
|---|---|
| Steps | `org_roles.line_workflow_slug`, the shipped template when unset (read as "Standard"); a version per finding source by `workflows.serves` |
| Takes from | the projects the role leads (`projects.owner_role_id`, `lineRoleOf`) and the finders that file into them (`projects.line_profile.finders`) |
| On switch | `org_roles.caps.line_on`, with the role's `trust` (`lineStartsOn`) |
| Decides | the person the role's reporting line ends at; the workspace owner for protected categories (line-profile.md LP6) |
| Merge, review agent | `org_roles.line_merge`, `org_roles.review_backend` |

One role owns at most one flow. Many flows may run the same steps: every flow
on the shipped template shares it, and customizing steps copies the graph into
the project's repo. A flow is named by its owner (`/flows/<handle>`, titled
with the role's name). Flows in the pool with no owner (`change` and the
segments) are run by hand: steps only, decided by the person who answers for
the change.

## FL1. Words

| Word | Meaning | Home |
|---|---|---|
| flow | one graph in the pool: a `.cast` file the runner executes | `.codecast/flows/<slug>.cast`, a shipped template, or a `workflows` row |
| owned flow | a flow a role owns, which starts its projects' problems by itself while on (FL0) | the owner role's fields |
| whole flow | a flow that takes a change all the way to done | a flow whose graph says `kind="line"`, or the shipped `line` |
| segment | a flow that does one part of the path, such as check, eval, review, decide or ship, or prove then implement | a flow whose graph says `kind="segment"` |
| pool | every graph a team can run: shipped, the repo's, and the team's pushed ones | `cast flow ls`, the flow list on /flows |
| change | what runs through a flow: a task's branch, a session's own edits, a branch, a pull request | the run's bound task, `$branch`, `$worktree` |

Every flow is run, versioned, gated and drawn the same way (the-line.md).
Nothing here adds an engine, a decision rail or an evidence model. Identifiers
keep their names: the shipped slug `line`, `kind="line"`, `.codecast/line.toml`,
the `org_roles.line_*` fields and the `cast line` commands.

## FL2. The pool

A flow lives where its project's code lives, as the line does (LM6):
`.codecast/flows/<slug>.cast`, with its station prompts and scripts beside it
in `.codecast/flows/<slug>/`. A flow is versioned with the code, reviewed like
code and published to the app on push, so anyone on the team can read it.

Resolution of a flow name, in order: a path on disk; the repo's
`.codecast/flows/<slug>.cast`; a flow the CLI ships
(`packages/cli/src/workflow/templates/`); a flow published to the workspace's
pool, by slug. The repo's flow is read from the checkout, so a checkout cut
before the repo's flow landed would resolve the name to the library or the
pool instead. `cast flow run <name>` refuses that case before starting
anything: when the name resolves outside the repo but the default branch
(`origin/HEAD`, else `origin/main`) holds `.codecast/flows/<name>.cast` at the
repo root and the checkout's root lacks it, it says so and names the fix
(rebase, or run from a checkout that has it); `--library` runs the library's
flow anyway. `cast flow show` prints the same note without failing. The same
order holds for a segment named inside another flow:
each published flow the CLI reads from the pool is written under
`~/.codecast/flows/<row id>/` and indexed by slug (`teamFlowIndex.ts`), so the
parser finds a team segment on this machine for a local run and a daemon run
alike. A read that names no team reads the pool of the team this directory is
mapped to (`cast teams map`), else the active team (`directoryTeam.ts`).

The pool is the team's. `cast flow publish` files the flow's `workflows` row
under the publisher's team workspace (`workspace` is `team:<id>`, `team_id`
routes it; `--team` names another team, `--team personal` keeps it theirs),
and every member reads it: the web through `workflows.webPool` into the
`workflows` collection, the CLI through `/cli/workflows/pool`, marked as the
team's with who published it. Any other push (a run's, the web's edit) is its
owner's alone and leaves a published row where it is; a push that makes the
graph a draft or drops `kind=` takes it back to its owner. A row from before
keys stays its owner's (`workflows.backfillWorkspace`). To run a teammate's
flow, the CLI writes the row's source and each station's text under
`~/.codecast/flows/<row id>/` at the paths the publisher's checkout held them,
and runs that file.

The web holds no parser and reads no checkout, so each checkout reports its
repo's own flows: the session-start refresh (`stableContext.ts`,
`workflow/repoFlowsReport.ts`) sends every non-draft `.codecast/flows/*.cast` graph,
parsed with its `extends` expanded, under the checkout's git top level and the
repository its origin remote names, whenever they changed since this machine
last sent that checkout's and at least once a day (`checkout_flows`: one row per
person and checkout, read only by that person; a checkout silent for two weeks
is dropped). A repository's worktrees sit on different branches with different
flows, which is why the key is the checkout. The Ship picker reads the row for
the session's own checkout (its `git_root`), else its repository's newest, and
builds the pool in the CLI's order: those flows, then each shipped flow they do
not name, then the published ones, so it draws the flow a press runs. A
checkout with no origin reports nothing, and a teammate's picker on someone
else's session lacks the repo's flows until their own checkout of it has
reported. A team
flow never overrides a shipped one of the same slug: a directory that is not
mapped reads the active team's pool, so an override would follow the person
into every other repository they open.

The graph says what kind of flow it is and what it is for, so the pool needs no
second record of it:

```dot
digraph review {
  graph [kind="segment", label="Review", description="An independent session reads the diff against the intent", takes="branch"]
  ...
}
```

- `kind`: `line` or `segment`. Declaring a kind is what puts a graph in the
  pool: any other graph (a probe, a trial's copy, an old template) can still
  be run by name, and is offered to nobody. The shipped `line` is in the pool
  without one, and so is every `.codecast/flows/<slug>.cast` in the repo.
- `label`, `description`: the name and the one line a picker shows.
- `takes`: what the flow needs from the change. `task` (a task with a goal and
  criteria), `branch` (a branch or worktree holding the change), or both.
- `draft`: the session an import belongs to until it is made general (FL5).

The CLI ships a starter pool: the `line`, the `change` line (PR, CI beside
review, merge, deploy: FL4), the `quick-change` line (check, review, ship: landed on the
reviewer's approval with no person asked), the `climb` line (FL10: hill-climbing one goal metric through its environments), and the segments `check`, `eval`, `review`, `judge` (FL9), `decide`, `ship`,
and `prove-implement`, cut from the shipped line's own station files so their
prompts stay one copy. The web reads the shipped pool from a generated
snapshot (`packages/web/lib/line/shippedFlows.generated.ts`, regenerated by
`bun packages/cli/scripts/gen-shipped-flows.ts`, checked by
`shippedFlows.test.ts`), and both sides fold a graph into its stations through
one function, `foldFlow` in `packages/shared/contracts/flowPool.ts`, so `cast
flow ls` and the app list the same steps in the same order.

## FL3. Segments compose

A node with `flow="<slug>"` (drawn `shape=folder`) runs a segment in place.
The parser expands it before anything else reads the graph: the segment's
stations join the graph under the node's id (`review__review`), its start
becomes the node's entry, and each of its exits becomes the node's way out.
The node's outgoing edges route on how the segment ended: `outcome = success`
when it reached a plain exit, `outcome = failure` when it reached a stop exit,
and `<node>.exit = <exit id>` names which exit it took. A stop exit the node
routes on keeps the segment's words for why: whatever the edge leads to reads
them as `$stop_reason` (cut to the lines that say what broke and the output's
end), and the segment's label as `$stop_stage`. A stop exit the node does not
route on ends the run, as before.

A segment names its params in `params` (`params="except above=50"`). `$except`
in its stations' words and in its edges' conditions reads the composing node's
attribute of that name (`judge [flow="judge", above=60]`), else the default
after `=`, else nothing; a segment run on its own reads its defaults. A value
is held to words, names and paths, since it lands in scripts as written.

Expansion is a parse step, so the runner, checkpoints, gates, graph hashes and
the map work unchanged: each expanded station is an ordinary station with its
own hash, and a change to the segment changes the hash of every flow that uses
it. The map groups an expanded segment's stations under the segment's name.

## FL4. How a change enters a flow

`cast flow run <flow>` binds a run to one change. With no flow named it runs
the workspace's default flow (below, `defaultFlowOf`), says which, and `cast
flow ls` marks it, so instructions that say `cast flow run` outlive a rename:

| Flag | The change | Bound task |
|---|---|---|
| `--task ct-N` | the task's branch (`line-<task>`, or the one an earlier run of it left); with none, from inside a session, that session's own edits | that task |
| `--session [id]` (the default from inside a session) | the session's own edits | the session's bound task while it is open, else a new task titled for the session and bound to it, so a second run finds the same task, branch and worktree |
| `--branch <name>` | that branch | a new task titled for the branch |
| `--pr <n>` | the pull request's head branch | the task linked to the pull request, else a new one |
| `--checkout` | everything uncommitted in the shared checkout, a commit per session that wrote it | a new task titled for the pass |

A session's own edits in a shared checkout are frozen the way `cast ship
checkout` freezes them (ship-checkout.md, `freezeAndAttribute`): every changed
file the session wrote since that file's last commit becomes one commit on
`codecast/<flow>-<task>`, and nothing in the shared tree, its index or HEAD
moves. The upstream branch is fetched once per freeze, before the preview
(60 seconds at most, never prompting; a failed fetch reads upstream as last
fetched), so the stale-copy guard reads upstream as it is now. The commit is
built on HEAD, the base its frozen content grew from, then replayed with the
checkout's own unlanded commits onto that upstream in the object store
(`replayOnto`), so Check and Review test the change on what it would land on,
and every reviewer's diff starts there (`$diff_base`, the change's `base`,
else the remote's default branch). When the replay fails, the branch stays on the
HEAD-based commit and `change.json` records `behind`: a `conflict` (with its
paths), which Ship's rebase meets again and routes to the session, or an
`unreplayable` history (a merge commit in the checkout's own), with the
reason; `cast flow run` prints it in one line. A checkout already holding
upstream, or with none, keeps the commit on HEAD. A change whose every file
upstream already holds at its frozen content is `landed`: `cast flow run`
says so and starts nothing (under `--json`, `{landed, upstream}`), and a
refreeze records it and the run ends done there.
Attribution is per file, so a file another session also wrote holds both
sessions' lines. The freeze takes only this session's lines from it when the
file is fully accounted for: each writer's Edit and MultiEdit calls since the
file's last commit replay onto the committed file (no Write or shell command
of it), and those versions merged reproduce the frozen file exactly
(`workflow/ownLines.ts`). A line no replay explains, such as the session's own
from before a commit that left it out, or a formatter's, fails that. Otherwise
the run includes the whole file and names the other session and why, rather
than leave out part of the change. Credential files stay out. The worktree is the one the run's isolated stations would make (`cast ws acquire`,
same name), and `$run_dir/change.json` records the change; the runner reads it
before the first station (`frozenChangeContext`), so `$branch` and `$worktree`
are set from the start, for a detached daemon run too. A rerun on the same
task moves the branch and resets that worktree to it, and refuses when the
worktree holds uncommitted work of its own.

A checkout's change (`--checkout`, what `cast ship checkout` starts when
`[ship] flow` names a flow) is the whole shared tree's pass, planned as a ship
pass plans it (`makePlan`): a commit per session that wrote files, with the
session trailer when that session is team visible, one for files no session's
edit names, and credentials and stale copies held out. The commits are built
on HEAD and replayed onto the fetched upstream the same way (`cutChange` in
`flowChange.ts`). `change.json` records `writers`, the session that wrote each
file; the session that ran the command, when there is one, is the run's
subject. A refreeze rebuilds it from the checkout as it is now, for the
change's files, any file one of its writers now holds (a fix may add a test),
and any changed file no session's edit names that was written or moved after
the brief went out when the writers' changes explain it (a writer's shell
makes those: the lockfile of a manifest a writer changed, codegen beside a
writer's source or in a generator directory above it, a `git mv` target with
its source). Any other late file is another session's install or codegen and
is held out with why. Still a commit per writer on the same branch. A pass whose files the checkout no longer changes because upstream
already holds them has landed, and the run ends done, as a session's change
found on upstream does. One checkout runs one such pass at a time
(ship-checkout.md).

A station the subject would do (below) goes to the writers instead: the
change's files that `$stop_reason` or the expanded brief names are grouped by
the session that wrote them, and each writer gets the station's brief as a
quiet send with a line naming its own failing files (`writersNamed`,
`briefWriters`). A file is named by its path, never as the tail of a longer
one, or by a basename no other file of the change shares, standing alone or
as a location (`a.ts:12`, `a.ts(12,5)`), never inside another path. Lines that
say something failed, and those beside them, are read first; git's
`Auto-merging` lines and a test runner's header for a file whose tests passed
are never read. Named files no session wrote go to the subject, in the same
send when it is also a writer; with no subject, the station's output and
`last_error` say nobody heard about them.

Every writer's row is read before any brief goes, and a send that fails
partway tells the writers already briefed, quietly, that the run no longer
waits on them. The run waits on every briefed writer at once with the
subject's wait, each on its own copy of the run's context. A writer is not
parked, so its brief can queue behind a turn of its own: it has answered only
when a turn after the brief reached it has ended (a pin after the brief's
delivery, read from `/cli/messages/status`, or quiet reads after it; where
delivery cannot be read, the transcript growing past the brief, going quiet,
and a pin since the brief went out). The first writer to block or die stops the other waits, which hear
the run no longer waits on them, and only its words reach the run: a block
before a death, a death before success. Once every writer has answered the run
freezes the pass again and goes on; the station's output names who was
briefed. A finding that names no file of the change goes to the subject, and
a run with none stops with it, as any run with no subject does. The writers
are other people's sessions in a shared checkout, so nothing parks or retires
them, nor the subject of a checkout's change.

Every run binds to a task because the run's evidence, its gate decisions and
its status already key on one (the-line.md L3, L6). The task is the record of
the change; the session that made it stays linked to it.

### The session is the run's subject

A run on a session's edits talks to that session through its stages. The
session's conversation id is in `change.json` (`$change_conversation`), and it
is the run's spawner, since the session runs `cast flow run` itself (the Ship
button asks its agent to). A station with `backend=subject` is work for that
session: the runner sends its brief, which names what a stage found, as a
message in the session's own thread, waits for the session to work and settle
(the station wait every session node uses, `waitOnStation`, which holds
through a dormant pin and stops on a blocked one), then freezes the session's
change again on the same branch and resets the run's worktree to it
(`refreezeSessionChange`). The session is never reported as a hand of the run,
so the run's end does not stop it as it stops hands. The runner reads the
subject's row with `include_killed` (`/cli/inbox`), so a killed subject is
still read, and sent the brief all the same: the send restarts it, and the
run's log says so. Only a subject the run cannot read stops the station.

Between its own stations the run does not need the session, so it parks it
(`subjectPark.ts`). Before every other station, and every minute while one runs
(Deploy's wait can last days), the runner reads the subject; once it has
settled (`done`, `dormant` or `idle`, live, not parked, not killed) the runner
stashes it hidden, once per settle, so it leaves the inbox, and asks its daemon
to hibernate it, at most every five minutes while it stays live. The daemon's
parking gate may refuse (attached, mid turn, resumed in the last ten minutes);
the run asks again later. A subject that is back in the inbox at the settle the
run stashed was brought back by a person: the run stashes and parks it no more,
and notes it in the run's context (`subject_kept`), so a resumed runner keeps
to that. A dry run and a run with no subject park nothing.

Everything the run sends its subject carries a `client_id` of its own (the
run, what it sends, and a nonce), never one built from visit counts, which
start over after a person's answer and on a resume: a second Revise brief
keyed on them was taken for the first and dropped. Briefs
and a gate's answer go out as quiet sends (`sendSessionMessage` `quiet`): like
a trigger's wake, a quiet send from a session leaves a hidden stash and a
snooze in place, while a killed or dismissed session still revives. So a
session working on a failed check stays out of the inbox, and surfaces on its
own only when it pins blocked. A run with no session of its own sends no
quiet briefs, and its log says so. A hibernated subject is not resumed to hear
a gate's answer. A server older than `quiet` refuses the send, and the runner
sends it again plain under the same `client_id`, so a first send that did land
is kept once.

A run that completes retires its subject once the change is live. The change
is on the default branch (`landedCommit`, fetched and decided with git), and
every deploy target its files touch runs a deploy that holds it, read once
from `/cli/deploys/targets` the way `cast flow await-deploy --once` reads it
(a change no target ships is live when it lands; targets that cannot be read
are not live, and neither is one `.codecast/deploy.toml` declares that the
server has never listed). Merged is not live: a flow that ends at its merge leaves the
subject to hear the end, which carries the deploy's reach. The subject has
settled (parked counts), and nothing it wrote differs from what landed (every
file `previewSessionChange` attributes to it reads as the landed commit or the
default branch has it; a session with no changed file left has nothing, and an
attribution that fails keeps it). Then the runner asks the server to retire it
(`cliRetireSession`, with the transcript length it read): the same kill as
`cast kill`, refused when anything would be cut off, because a kill also
cancels the session's triggers, drops its queued messages and tears down its
nested sessions. It refuses when the transcript moved since the read, a
message is queued, a trigger is armed on it, it is working or waiting on
background work, or a nested session of its own is live or has a message
queued or a trigger armed (the kill takes those down too). A retired subject is
not told the run is over, which would only resume it to read "done"; the exit
station's `result_preview` says it ("Retired jx7...: its change is live from
main at ..."). A subject already killed when a run completes (someone retired
it, or an earlier run did) is not told either. Otherwise the session hears the
end as below; a failed run's end message is an ordinary send that revives a
killed subject on purpose, so the failure reaches someone.

The `change` flow is the ship model for every workspace, with no person asked
on the way:

```
PR → (CI ‖ Review) → Verdicts → Merge → Merged → Deploy → Live
 ↑                       │         │
 ├──── Fix findings ←────┤         ├── Resolve conflict → PR
 │                       │         └── Retest → CI   (at most 3 times)
 │                       ├── Wait for main → Onto main → CI   (at most 2 times)
 └──── Revise ←── Ship card ←── edits CI
```

PR (`cast flow pr`, `workflow/prStation.ts`) starts each round: it deletes
the last round's `ci.json`, `review.json`, `merge.json` and `rebase.json` from
the run's directory, pushes the run's change branch and opens its pull
request, or finds the open one the push just updated, and writes `pr.json` =
{url, number, head_sha, branch, round}, where `round` is a fresh random nonce.
A branch goes up as a fast forward, or with `--force-with-lease` over exactly
the head this run last pushed there (a branch frozen from a session's edits is
the run's own, and a session's fix may rebase someone's branch); a head anyone
else pushed is never overwritten, and a pull request from a fork stops the run
(the station pushes only to origin). CI and Review then run at
once in a fan-out (FL3's `shape=component`). CI (`cast flow ci --head <pr.json's
head>`) always exits 0 with `ci.json`: the head it judged, green or not, and
each failure with its job, test, assertion, file, line and excerpt. The
reviewer is an independent session reading the line's review prompt plus
`templates/change/review.md`: it reviews commit `pr.json.head_sha`, not the
branch as it stands, records its verdict with `cast flow review-verdict`, and
pins `{verdict, findings, round, head_sha}`, the verdict exactly `ship`,
`changes` or `rejected`. A reviewer whose session dies in the fan-out is asked
once more on its own; a second death stops the run at Review never finished.

Verdicts (`cast flow verdicts`, `workflow/changeVerdicts.ts`) is given that
pin and reads `pr.json` and `ci.json`. A file is never a verdict: anything on
the machine could write one, the change's own author included, and a reviewer
moved to another machine could not. The pin counts only with this round's
nonce and the head CI judged, or a head the run's own stations rebased from
it this round (`pr.json`'s `rebases`), so neither a pin left from an earlier
round (a fan-out keeps a branch's last output when the new one holds none)
nor one on a head someone pushed since ever does. Verdicts writes the
accepted pin to `review.json` for Merge, removes the file otherwise, and
prints `{ci, review, next, why, ...}` as its last line, which the run card
reads; it shows at most ten of CI's failures, each excerpt cut, with their
count, and the brief points at `ci.json` for the rest. When origin's branch
has moved off the round's head (someone pushed while CI waited for it), a new
round at PR reviews what is there, three times at most before the run stops at
Branch keeps moving, naming the head it last saw. A pull request CI reports as conflicting
with main (GitHub runs no CI on it) goes to the session to bring up to date
(`templates/change/ci_conflict.md`). Green CI on the head PR pushed and a `ship` merge; a rejection ends at
Rejected with the reviewer's findings. What only the machine can fix runs
once more in the round, then stops at a machine end, and never reaches the
session: CI that left no `ci.json`, judged another head, timed out
(`timed_out`), or failed in its own station (a `failing` entry whose job is
`ci-station`) stops at CI never reported, although real failures beside the
station's go to the session after the rerun; a review that never arrived (no
pin, another round's or head's, an unknown word) is asked once more, then
briefed; a Verdicts station that fails stops at No verdicts. When every CI
failure also fails on main (`ci.json.blocked_by_main`), nothing is the
change's to fix: Wait for main (`cast flow wait-main`, `workflow/waitMain.ts`)
parks until the default branch's own CI is green at its head, saying how long
it has waited against its 4h deadline, then `cast flow pr --rebase` puts the
change onto the new main, pushes it and records the rebase as Merge records
its own (`workflow/rebaseRecord.ts`, on the server and in `rebase.json`, whose
every link Merge checks is a real rebase), keeping the round and its review,
and CI runs again. It waits at most twice a run; past the deadline the run
stops at Main stayed red, naming main's red jobs, and the session is never
briefed for it. A change that edits CI (`ci.json.ci_changed`) is one CI
cannot vouch for: when CI is green and the reviewer says ship, the run comments why on the task and asks the `decide`
segment's Ship card; Ship merges, Revise briefs the session with the person's
note, Drop ends the run, and a run with no session behind it stops at Needs a
person. A CI-editing change CI finds red goes back like any red. Anything
else is one brief to the session (`templates/change/brief.md`) carrying the
reason, the failures the change causes and the review, and with no session
behind the run it stops at Found work with the same reason. The reruns are
counted in `pr.json`, so each round gets its own. Merge (`cast flow merge`)
reads `ci.json` and `review.json` and prints the sha it put on main; on
success its station's output is `merge.json` alone, and Deploy is reachable
only on `outcome = success and merge.json.sha`, through Merged, a step that
prints the sha. Merged's id is `landed`, which the runner reads as the change
being on main, so a deploy that fails after it tells the session its change
landed. A conflict is Merge's exit 1 with its conflict line ("… conflicts
with …") or its stale-tree line ("… rebuild the change on …"), briefed to the
session (`templates/change/conflict.md`). A merge main moved under, where the
two diffs interact, pushes the branch rebased and records the rebase the same
way; Retest (`cast flow pr --refresh`) keeps the round and its review only
when origin holds exactly a recorded rebase of one of the round's heads,
records it in `rebases`, and runs CI again, at most three times before the run stops at Main
keeps moving. Any other head on origin (someone pushed) exits 4, and a new
round at PR reviews it; `--rebase` does the same. Any other end of Merge
stops at Not merged with its output. When the session's fix lands on a local
branch that lags such a rebase, PR replays the new commits onto origin's
branch before it pushes. Every way back to the session returns to PR, so what
merges is exactly the commit CI and the reviewer passed, never the session's
live edits. Each way back has `max_visits=3`; the fourth visit ends the run.

`quick-change` keeps the older shape, built from segments: Check (a slot),
Review, Land (the `ship` segment), Deploy. A failed check, the reviewer's
"changes" and a rebase conflict at Land each go back to the session and then
to Check (`fix_check.md`, `fix_review.md` and `fix_conflict.md` in
`templates/change/`).

In both, the session hears how the run ended (done, or stopped where and why)
in its own turn. A run on a task, a branch or a pull request started from inside a
session has that session as its subject too (`callingSubject` in
`flowCommand.ts` writes it into `change.json`): the session fixes the change by
committing to the branch (pushing, for a pull request), and the run reads the
branch again rather than freezing edits (`$change_return` in the briefs says
which). Started from a plain shell (say over ssh on another machine), its
subject is the session the task's change came from (`change_session` on
`/cli/work/get`): the session bound to it, else the newest live session that
handed it off (`cast task handoff`). A run with no spawner asks its gates from that session, so the card opens where
the work is rather than on the run's own log. With neither, it has no
subject, and its first fixable stop ends it with what the stage found.

A check the machine could not run (LP4: the check exits 2, say no test
database could be built) is not a finding about the change. Check routes it to
its own exit, `Not checked here`, marked `machine=true`, and `quick-change`
sends that exit to a stop of its own rather than to Fix check. The runner
returns the task to in_review, posts the reason as a note (not a blocker, so
the task's followers are not notified), and the run's owner hears it: its
subject session in the run's end message, else the person whose account ran
it, through a note posted `to_owner`.

Every comment a run posts goes through the run's own primary session, so it is
signed by the run ("Change run"), and so are its notifications
(`lib/actor.ts` kind `run`); the stop words carry `$<station>.summary`, the
check's failing steps in one line, and the comment links the run's page for
the full output.

### Merge: the station names the sha that landed

`cast flow merge --pr <n> --branch <branch> --dir $run_dir`
(`workflow/mergeStation.ts`) is the change flow's Merge station. It reads
`ci.json` and `review.json` from `$run_dir` and nowhere else, and refuses
(exit 2) unless CI is green, `ci.json` names the `head_sha` it tested, and the
review said ship on a `head_sha` it names. A pull request whose head is not
CI's sha, because something was pushed after CI, goes back to CI (exit 3)
before anything is stamped. That sha is the one `--match-head-commit` pins, so
only the head CI tested merges. It must also be the head the reviewer read, or
one a chain of the stations' own rebases leads to from it (R to X to Y). Both
come from the server's record for this attempt
(`/cli/workflow-runs/merge-proof`), never from review.json or rebase.json. The
station checks each link against git before it trusts it: with B the
default-branch commit `to` sits on, `git merge-tree --write-tree` of B and
`from` over their merge base must give exactly `to`'s tree. Any other head,
or a link that fails the check, is refused (exit 2) with "it must be reviewed
again". The station then stamps the
run cleared by its own graph (`orgLineMerge.clearForMerge`) for that head.
The server accepts the stamp only when it holds these from this attempt, from
stations that lead to Merge (the-line.md):

- the green verdict `cast flow ci` recorded for that head from its running
  station;
- the reviewer's ship, recorded by the reviewer's own session with `cast flow
  review-verdict`, on that head or on one a recorded rebase chain leads to
  from it;
- when the change edits CI's own config (`ci.json`'s `ci_changed`, sent with
  the stamp and in the CI verdict), a person's Ship on this run's card. Without
  one the station exits 2 with "this change edits CI; a person must answer
  Ship".

The files in `$run_dir` are what the graph routes on, and the server's record is
what authorizes. Both protect against confused or mistaken agents and stale
state. Neither protects against a process holding the owner's token, which
could push the default branch directly anyway. The station asks `/cli/line/merge/check`, and refuses
with the server's words when nothing authorizes the merge. It never passes
`--admin`.

Two holds keep deploys and merges in order:

- **The checkout's merge lock** (`<git common dir>/codecast/merge.lock`;
  `workflow/mergeScratch.ts`), from the rebase to the landed sha. It orders
  stations on one checkout. It is a file made with O_EXCL that names its
  holder's pid and that process's start time, so a pid a reboot reused holds
  nothing. A lock whose holder is gone is removed only under a takeover claim
  (one waiter at a time), and only if it still holds what was judged gone.
- **The repository's lease on the server** (`repo_leases`,
  `convex/repoLeases.ts`, `land/repoLease.ts`), from the first before-merge
  step to the landed sha. It orders stations and `cast ship checkout` (from its
  first before-push deploy to its push) on every machine. There is one lease
  per repository, whichever workspace takes it, since every workspace connected
  to a repository deploys the same production. Taking it needs access to the
  station's run workspace, so it never depends on how many teams connected the
  repository; `cast ship checkout`, which has no run, needs the repository's
  team. A holder renews it every minute, and it lapses ten minutes
  after the last renewal. A renewal extends only the holder's own row and never
  takes a lease back. A station that finds it held waits and names the holder.
  A holder counts the lease lost when a renewal is refused or none has
  succeeded for five minutes.
  The station asks the server outright before each step and before the merge,
  and refuses (exit 2) when the lease is no longer its own.

The station works in a worktree it acquires under the main checkout, set up
(env files, `bun install`) only when a step will run. The workspace state marks
it as the station's own (`purpose: merge-scratch`, with the station's pid and
start time). It is released afterwards. On SIGTERM it is released only once the
running step's whole process group has stopped, which boots out deploy.sh's
launchd job; a step that will not stop leaves its tree in place. The next
station sweeps only trees marked as its own, named `merge-scratch-*`, older
than three hours and whose maker is gone. A person's workspace named `merge-*`
is never touched. Each round
fetches the default branch fresh and rebases onto it. A conflict exits 1,
naming the files and the default branch's commits that touched them. So does a
change that would set the default branch's recent work back (a stale copy
built on an old tree, lineMerge's `undoneChanges`): the line names each file
with the commit it would undo and says to rebuild the change on the default
branch, which the change's session does as well as anyone. When the
default branch changed one of the change's files since `ci.json`'s
`tested_main_sha`, a model judges whether the two diffs interact. It runs on
the call node's path, `/cli/model/call`, with the diffs fenced as untrusted
data. Interacting, or no answer, records the rebase as a link from the head CI
tested to the rebased head, on the server and in `$run_dir/rebase.json`
(`recordRebase` in `workflow/rebaseRecord.ts`, which the PR station also uses
when it rebases while waiting for main). It then pushes the rebased branch and
exits 3. The run goes back to CI on a head the
review still covers. Files the default branch did not share merge without a
retest.

The before-merge steps are the `[[ship.deploy]]` steps with
`stage = "before_push"` that the default branch's own line profile names (read
at the commit the change is rebased onto, so a change never decides its own
deploys), whose `when` globs match the change's files. They run from the
rebased tree (codecast: the typing guard and `packages/convex/deploy.sh`, from
a tree that holds origin/main). Any of these starts another round on the new
default branch, up to three:

- the default branch moves before a step;
- it moves while a step fails, as deploy.sh refusing a tree that is BEHIND does;
- it moves under a step's paths while the step runs.

A step that fails otherwise exits 2 with its output's tail. Once a step has
gone out, production must not keep a backend the default branch lacks. So any
exit that merged nothing first sends those steps again from the default branch
as it is then, still under the lease, records that deploy, and says so: "nothing
merged, so backend went out again from main at <sha>". If the lease was lost
and cannot be taken back, the line says exactly what is deployed instead.

The merge is `gh pr merge --squash --match-head-commit <ci.json's head_sha>`.
Its body lists the branch's commits and keeps each distinct
`Codecast-Session` trailer, so `cast blame` still finds every session. The
station prints the PR's merge commit only once origin's default branch holds
it, reading again for about ten seconds while GitHub's replicas catch up. If gh
reports a merge whose commit the default branch lacks, it exits 2.

When the landed commit differs, under a step's paths, from the tree that step
deployed, the step runs again. That happens when the default branch moved
after the last check, or when the squash differs from the local rebase. It runs
from the default branch as it is then, which holds the landed commit (deploy.sh
refuses a tree behind main), and the tree is set up again when dependencies
changed. The station writes `$run_dir/merge.json` = {sha, pr, url} and records
the merge on the run (`/cli/line/merge/record`) as `cast line merge` does. It
records each step's target as deployed at the sha it went out from, through
`/cli/deploys/ship-pass` as `cast ship checkout` does (deploys.md DP11), so
Deploy finds the backend live. merge.json is written the moment the merge
lands, and a station stopped after that point still prints the sha and exits 0.
A rerun that finds the pull request already merged sends the before-merge steps
its commit calls for again from the default branch, since the attempt that
merged may have died before it could. A crash exits 2 with `station crashed:
<error>`, so exit 1 always means the change must be rebuilt on the default
branch.

`cast flow review-verdict --verdict <v> --head <sha> [--round <r>]`
(`flowStations.ts`) is what the reviewer's session runs to record its verdict.
The session names itself from its own environment, as every `cast` command run
inside a session does. The server finds the running run and the reviewer node
(composed ids such as `review__review` included) whose reported session is
exactly that session in this attempt, so the prompt needs neither the run nor
the node. `--run` and `--node` are there only for a session that is the
reviewer of more than one.

A lease lost after a step went out may mean another holder deployed over it.
Before exiting, the station waits up to fifteen minutes to take the lease back,
then sends main. A station stopped while it sends a step again says, on the way
out, that production may run a backend the default branch lacks.

### Deploy: the run takes the merged commit live

Both change flows end at Deploy: after Merge in `change`, after Land (the `ship`
segment) in `quick-change`. The `deploy` segment is one station
with `parks=true`: while the run stands there it holds no machine slot and no
session. The station runs `cast flow await-deploy --merge $run_dir/merge.json`
in the run's worktree. It starts only from the sha Merge wrote there, else the
merge recorded on the run (`run.merge.sha`, which `cast line merge` writes
without a merge.json): with neither, or a sha that is not on origin's default
branch, the run stops at once at Not merged. The `ship` segment writes the same file. After Land's command exits
0 it runs `cast flow landed`, which finds the commit on origin's default branch
that carries the branch (the tip itself, a squash whose files read as the
branch left them, or the first commit a replay already holds, where merging the
branch in changes nothing; a change that only deletes files needs one of the
other two, since main may have moved them) and that the
branch changed something of its own since its fork, read before the land
command ran and kept in `$run_dir/since`. It records that commit on the run as
its merge through the record `cast line merge` and the Merge station use
(`/cli/line/merge/record`), as an observed landing: only the run's own runner
may make it, it spends no merge allowance, says nothing on the task, and fills
an empty `run.merge` only, never one the Merge station recorded. So
`run.merge.sha` is the one landed truth whatever path landed the change; a
record that fails is logged and Land goes on. With none, Land fails at Not shipped ("Land reported success but
<branch> is not on main: nothing was merged"), so a land command that never
committed can never send a run on to Deploy. Without a ship command, Land's
`cast ship run` only starts Ship's session, which merges the pull request
later: Land waits up to an hour for that merge, naming the pull request on the
card, and a pull request still open then ends Land at Not shipped with a
progress note naming it and saying this run will not deploy the change, not a
blocker. A known cost: Land does not park, so that wait
holds a machine slot for up to the hour. Rebase's already-landed exit writes the file too,
for the commit that already carries the change, starting from the fork Land kept
(after a fast-forward the branch's fork is its own tip), else the commit the run
froze the change on; with neither it writes nothing, since a branch with no
commit of its own also sits on main. Of the targets the change's
files touch (`cast line deploy targets --json`, deploys.md DP10 to DP13) Deploy
sends the `release` ones (`send` defaults to release, the library's default),
waits on the `push` and `auto` ones, and only waits, a day by default, never
sending, on `press` targets and the line profile's own deploy target, which a
person or a role sends (deploys.md DP15 has the rules): the run ends Live only
when every touched target carries the change. A flow whose
deploys a person sends composes it `deploy [send=""]`: it sends nothing and
only waits. A target is live once a deploy recorded live has a sha the merged
commit is an ancestor of, decided with git in the worktree; the first such
deploy is the dp-N that took it live. While it waits, the card shows each
target with what it waits for, how long and its deadline (`cli: dp-13 sending
1a2b3c4 (12m of 45m)`). When every touched target is live it prints `Live: <sha>
on <target> dp-N, ...` and the run ends there; the session's end message
carries that line. A failed deploy ends the run at Deploy failed with the dp-N
and its note. A target past its `deadline`, or the wait's cap (the longest
deadline and an hour), posts one blocker on the task and ends the run at Deploy
stuck. A change no target ships passes at once. A flow that composes the segment may name targets
the change does not wait for, `deploy [flow="deploy", except="aivery-operator"]`:
one held back on purpose, whose live sha is not where the change's watch should
start; it still holds the targets that go after it. Union's fix flows end this way: Merge, then Deploy, then Watch, so a
cause closes Done and starts its watch only once production runs it, and a
failed deploy leaves it In Review with a blocker.

A segment declares the attributes it reads with `params="except send=release"`
in its graph line; `$except` in its stations is the composing node's attribute,
else the default written after `=`, else empty. The value lands in a script as
written, so the parser holds it to words, names and paths.

While the session works, the run carries `waiting_on_session` (`node_id`,
`conversation_id`, `since`, `note`: what was sent, cut short), cleared when the
session settles or the run ends; each node status carries `visits`, against
the graph's `max_visits`.

## FL5. A Claude Code workflow becomes a flow

A session that ran a dynamic workflow (the Workflow tool's `agent`,
`parallel`, `pipeline` and `phase` script) can add its shape to the pool:

```
cast flow import <script.js | wf_id> --as segment|line [--slug <name>]
```

1. **Trace.** The script runs in a sandbox with recording stand-ins for
   `agent`, `parallel`, `pipeline`, `phase` and the rest: no model, no
   network, no file access. Each stand-in records the call (its label, phase,
   prompt, schema, and which calls ran side by side) and returns a placeholder
   shaped like its schema, so loops and branches play out.
2. **Shape.** Code turns the trace into a graph: one station per agent call,
   calls made side by side become a fan-out and fan-in, a label that repeats
   across rounds becomes a loop back with `max_visits`, and the script's
   phases become the stages the map draws.
3. **Prompts.** Each station's prompt is written to its own file under
   `.codecast/flows/<slug>/`. A workflow's prompts usually carry the task they
   were written for; the session that wrote the workflow knows which words
   were the task, and rewrites them into `$task_title`, `$task_description`,
   `$branch` and the like. The command prints each prompt file for it.
   A script that reads `args` gets the args its run was launched with, read
   from the Workflow call in its session's transcript (`--args` overrides). A
   label carrying a round number ("critique:r2") marks a loop even when the
   placeholder answers ended the script after one round; the loop routes on
   the last step's `again` field, three rounds at most.
4. **A draft until it is general.** The import is written with
   `draft="<session>"`: only that session is offered it, and `cast flow
   publish` refuses it. The session makes it general (each station and the
   flow named for what it does in any change, a description and prompts that
   name no one task) and deletes `draft=`.
5. **Check and publish.** `cast flow validate` reads the graph and names what
   is missing; `cast flow publish` pushes it to the team's pool.

The Workflow card in the transcript offers "add to flows" once the run has
finished, which asks the session that ran it to do the import and make it
general, since it holds the context to.

## FL6. What people see

One drawing serves every surface (`FlowDiagram` over `lib/line/flowDiagram.ts`):
the path a change takes when every step passes, left to right; a segment of
several steps as a frame holding them; a fan-out as a frame of steps stacked
side by side; each step marked with who does it (an agent, a command, a
person). A definition shows the routes off the path as neutral words under the
step they leave, one form each: an end by its own name, a route to a station as
"outcome → station". A run shows each step done, current or stopped, and only
the route it took, red only where it stopped.

- **In a conversation**, a flow is one object (FL8): a `cast flow run` card
  follows the run live (state in words, the task, Stop while it runs, the
  library it builds on, Save) and stays visible, never folded into a "ran N
  commands" receipt; so does a flow the session wrote and read back
  (`validate -`, `show -`, a dry run). A ` ```flow ` fence draws
  `{"flow":"<slug>"}` or `{"run":"<id>"}` in any reply. The Workflow tool card
  carries "add to flows".
- **The team's default flow** (`teams.default_flow`) is the flow a session's
  change is offered first. A team admin sets it with Make default on a flow's
  page in /flows, where the library marks it Default; any flow that takes a
  branch qualifies. A team that set none, or set one that left the pool, gets
  `change`, labeled Ship (`defaultFlowOf` in `shared/contracts/flowPool.ts`). The CLI reads it
  from `default_flow` on `/cli/workflows/pool` and resolves it by the same
  function against its own pool (FL2's, the repo's flows included): a nameless
  `cast flow run` runs it, `cast flow ls` marks it, and session start names it.
  The default is the team's only when that team was named or the directory is
  mapped to it; an unmapped directory takes none and gets `change`, as session
  start, which reads no team there, names it.
- **On a session's header**, Ship lists the lines that take a branch from the
  session's own pool: the library's, the session repository's, and those filed
  under the session's workspace (its team, else the viewer's personal one), the
  workspace's default first and picked. Each row is the flow's label (a
  repository's flow that replaces a library one adds the repository's name,
  "Change · union-mobile"), whether a person approves before it lands, read
  from the graph ("You approve", "Asks if CI changes" when a person is asked
  only on a side route, "No approval"), and its stages. The stages are the
  journey's: a script bounded to a minute (Verdicts, Merged) is the stage
  before it finishing, not a stage of its own. It draws the picked one and
  opens the shared confirm review: steps, agent sessions that start, questions
  for you, who does each step, the ways it can end, how to stop. Confirming
  asks the session to run its own change through it. On a phone it opens as a
  sheet from the bottom. The pool's feed is read only while the list is open.
- **On /flows**, the landing view (G then W) lists the owned flows, one row
  each: owner, on switch, the projects it takes from, who decides, its steps,
  and what it holds now. The decisions count opens Decisions narrowed to that
  flow (`?view=foryou&flow=<handle>`), the queued count its problems. Under
  them, the pool run by hand and the segments, each opening its detail: drawn,
  what it takes, what it is made of, what it is part of, and the changes that
  ran through it, each opening its live run card.
- **On /flows/<handle>**, one flow's page: its overview (counts, owner,
  switch, projects, decider, merge, steps drawn) and the same Decisions,
  Timeline, Problems, Steps and Deploys views over its projects, one picked at
  a time. `/line` addresses from before redirect to their place under /flows.

## FL7. What agents see

`cast flow ls` prints the pool, one flow a line: its slug, kind, what it takes,
and its passing path (`Check → Review → Decide → Ship`, side routes counted).
`cast flow show <slug>` prints each step, who does it, and where it sends the
work, a fan-out's branches under it. The Workflows section of the agent
instructions (`shared/contracts/snippetsWorkflow.ts`, also `cast guide
workflows`) carries the commands and the segment syntax. Session start adds
one `<flows>` line naming the flows a session's own edits can run through,
the default first: this checkout's and its mapped team's (`flowsLine` in `stableContext.ts`,
about 320 bytes inside the 9000-byte budget the feed gives way to). Reading
the team pool there also refreshes this machine's copies of the team's flows.

## FL8. Flows a session writes, and backbones with slots

An agent puts its work in a flow one of three ways, and the agent instructions
(FL7, `cast flow --help`) say when each fits: a library flow that fits runs as
it stands; a library flow that fits as a backbone is extended, with the parts
this change needs done its own way written as generated segments; a flow is
written whole only when nothing in the library has the work's shape.

**Slots.** A backbone marks a node `slot="<what it must do>"`, optionally with
`flow=` for the steps it runs when nothing fills it (`quick-change` leaves its Check
as a slot with the `check` segment as default). A flow that names the backbone
by `extends="<slug>"` fills the slot with `subgraph <slot> { ... }`. The parser
(`parser.ts`) reads a fill as an inline segment and expands it exactly as
`flow=` expands a library segment (FL3): its steps take the slot's id as
prefix, its first step is entered from the slot, and its last leaves by the
slot's own edges. A fill written as a chain gets its start and exit made for
it. A subgraph may fill only a slot of the base or a node of its own file, so
a backbone's other stations stay the team's; an empty slot makes a flow a
backbone that `cast flow run` and the runner refuse, naming the slots to fill.
`extends` resolves a file beside the graph first, then a flow by name through
the same resolver as `flow=` (a library run passes its own, pinned to the base
version it recorded).

**Flows written in a session.** `cast flow run -`, `validate -` and `show -`
read the graph from stdin (`workflow/sessionFlow.ts`). The file is kept at
`.codecast/session-flows/<slug>/<slug>.cast` inside the work tree (so a run's
push records where it lives, and the library collects it as a session flow),
hidden through the checkout's `info/exclude`, and marked `draft="<session>"` so
the library offers it to nobody until saved. Each library flow it names by slug
is pinned beside it by a one-line stub extending the file the pool read, so the
runner, a separate process, parses the graph that was validated. A name the
library holds is refused. `validate -`, `show -` and a dry run push it as the
session's own draft graph and print where it is kept, so the transcript can draw
it before it runs.

**The object in a transcript** (`hooks/useFlowObject.ts`, shared by web
`FlowFence` and the phone's `FlowCard`). A run draws the graph it ran (its
workflows row through `graphOfRun`, readable by anyone who can read the run),
the library's own copy when it is the same flow, else the team's session-flow
row. A segment written in place reads as a filled slot ("written here"), read
from the source (`flowFills`) or the session-flow row's `fills`; a pushed row's
segment exits are found structurally, since stored nodes carry no segment
fields. Save is the session-flow row for the run's graph (matched by
`graph_hash` and workspace) through the store's `saveSessionFlow`; a saved one
links to its library slug and version, and a graph the library already holds
as it stands has no row and shows no Save.

## FL9. The blind judge

Every change gets the same risk check whoever made it: a person's session, an
agent or the line. The `judge` segment (`templates/judge.cast`) asks one model
how likely the change is to need a follow-up fix, as a percentage, and it
cannot know the author, because nothing that names one reaches it.

- **What it reads.** Two scripts build its input (`cast flow blind diff|guidelines`,
  `workflow/blindChange.ts`). The diff runs from the merge base of
  `$default_branch` and `$branch` to the branch, with every file named and its
  line counts; lockfiles, binaries and snapshots keep only their counts, and
  files too long for the station's record keep both ends. The `index` header
  lines go, and so do the range's author and committer names (each part of a
  name too), every email, the ids the flow names (`--redact $branch $worktree
  $change_session $change_conversation`) and signature lines (`Co-Authored-By`,
  `Codecast-Session`, `Signed-off-by` and the like). Commit messages and the
  branch name are never read. The guidelines are each CLAUDE.md or AGENTS.md
  at the root or above a changed file, as they stood at the base, each text
  once (a symlinked CLAUDE.md is read as its target).
- **Who judges.** A call station (`shape=note`, learning-loop.md LL1): one
  prompt (`templates/judge/risk.md`), no tools, no session, charged to the
  team's model budget. It cannot look anything up, so what the scripts hand it
  is all it knows.
- **What it records.** The call station's node record on the run
  (`<node>__judge`, segment_flow `judge`) holds its answer as
  `{"risk": 0-100, "why": "..."}`, and the exit the run passed says which way
  it went: `low`, `high` (risk at or above `above`, default 50), or `unscored`
  (a script or the call failed, or the answer held no risk). A change the judge
  passed (`low`) that a later fix traces to (`cast line fixloop`) is one of its
  misses; that rate is how the team learns whether to trust it.
- **Where it runs.** In the library only: no shipped flow uses it yet. A flow
  adds it after Review and records it (`review -> judge -> decide`), or gates
  on it by routing its exits (`judge -> ship [condition="judge.exit = low"]`,
  `judge -> decide [condition="judge.exit != low"]`, the bar set with
  `above=`). It earns a place in a flow when it tells that repository's
  changes apart better than their size does. Dry runs, each on 80 past changes
  (40 that a behavior fix traced to within 7 days, 40 size-matched that no fix
  touched; CI housekeeping fixes left out), AUC with its 95% interval:

  | Repository, input, model | Judge | Size alone |
  |---|---|---|
  | union-mobile, diff, sonnet-5-5 | 0.72 (0.62 to 0.83) | 0.50 |
  | codecast, diff, sonnet-5-5 | 0.56 (0.43 to 0.69) | 0.55 |
  | codecast, each changed file whole, sonnet-5-5 | 0.53 (0.40 to 0.65) | 0.55 |
  | codecast, diff, opus-5-5 | 0.51 (0.38 to 0.65) | 0.55 |

  So it carries signal on Union's changes and none yet on codecast's. On Union
  a bar of 60 flagged 15 of the 40 changes that later needed a fix and 4 of the
  40 that did not; a bar of 70 flagged 7 and 0.

## FL10. The climb

The climb (`templates/climb.cast`; design "Goals that agents can climb" §4)
hill-climbs one goal metric through the goal's environments (envs.ts, `cast
goal envs`): many cheap candidates on the dev split of the low levels, the
few that separate from base on the held split, one promoted to a production
experiment that a person approves. It is a whole flow that takes a task: the
task's `goal_ref` names the goal, and optionally the metric (`cast task create
"Climb in-9" --goal-ref in-9:dollars_per_intro`, then `cast flow run climb
--task ct-N`).

Agents write two things. Frame writes the climb card (`$run_dir/climb/card.json`:
target, levels with the plausible effect of one change on each, budget,
candidate count, hypothesis space); Propose writes the candidates, one change
each on its own branch from the base, with a hypothesis and a predicted delta
(`candidates.json`). Everything after is `cast climb <station>`
(`climbCommand.ts`, `climb/engine.ts`) under the rules in
`shared/contracts/climb.ts`, which no station can bend:

| Station | What it enforces |
|---|---|
| Gauge | The base is the default branch's upstream tip, fetched when Gauge starts, never the checkout's own HEAD: a shared checkout lags its default branch, and a base without main's latest env fixes fails the same way every run. A climb that builds on a pending change (a task promoted but not yet in main) names it on the card as `stack`, a branch or commit or a patch, with its task. The base is then that change applied onto the tip, as a commit no branch points at (a conflict sends the card back), so candidates are built on it and every effect is measured beyond it, and Promote files only the increment, blocked by the stack's task. The card records the base, the ref it came from, and how far the checkout's HEAD stood from it; a failed fetch or a checkout with no upstream is said there. The card held to the caps: it must climb the task's own goal, budget the smaller of the card's and the ceiling (the goal's own, else the product repo's climb.toml (in its .codecast directory) as committed at the base, `[goals."in-9".budget]` or `[budget]` with `usd` and `runs`, else $25 and 60 runs), at most 8 candidates, only the goal's own L0..L3 envs. Before anything runs, a preflight checks every chosen level and every goal L0 check in seconds, from git at the base and the goal's standings. Each must be declared at the base at its level, with a dev split and `protects` named, and a scoring level Confirm will run needs a held set in codecast. The card goes back to Frame with the whole list of what fails. A dev set in codecast is optional: an env with none runs on its own cases, as before sets existed. A scoring level must be a score: an env declared `role = "check"` (a sensitivity check such as the share of picks a fit read passes) is never climbed, because climbing it alone trades the score for it. Pins the base, the goal's checks (its L0 envs and its `role = "check"` envs), and the installed packages the grading files import. The files that grade are every env's `protects`, the files each env command names with the directory each sits in, and `.codecast/**`, `.gitattributes`, `.gitmodules` and `node_modules`. They are derived from git at the base at every station, never read from the climb's state. A level whose env declares no `protects` is refused: a runner imports the product it scores, so only the env's author can say what grades. Before anything is spent, it reads the card's `production_lift` (the plausible relative lift of one change on the goal metric) against that metric's own reading (`metricReadings`, its 4-week MDE). When no 50/50 test within half a year can confirm one change of that size, the card says so: the evidence for a winner is then its held-split result plus the goal's prediction record read back over many climbs. Three base runs per scoring level (reused only when filed at the same base sha before the climb's task existed) give its minimum detectable change, counting both the per-case spread and a shift of the whole run, and never below a floor that sets it when the base runs agree exactly, as a cached grader makes them. A level is compared paired, case by case, so its floor is the change a moved case makes times the square root of the share of cases a change moves over their number: the share from the card (`moved_share`), else from this level's earlier climbs in the registry, and the moved change from those climbs, else the cases' own spread. The unpaired standard error of the mean stands in only when neither says what share a change moves, and an env may declare its own floor (`mde`); a level whose MDE is above the card's plausible effect, or above 0.1 whatever the card says, is refused. A refused card goes back to Frame once (exit 5); no level that can see one change stops the climb (exit 3). |
| Admit | Each candidate starts at the base, is a commit no other candidate is, changes something, and touches no protected path (renames read as the deletion they are). |
| Review | An independent reviewer refuses candidates that game the score in ways a path check cannot see (`cast climb refuse`). |
| Screen | Dev split, cheapest level first, with the base's own declaration. Before each run the candidate's tree must hold the protected files as the base does (checkout filters included), and a run whose `env_version` differs from the base's is refused. A candidate goes on when its paired delta's lower bound clears 0 and the delta clears the level's A/A band; the better half go on when a dearer dev level follows. Each candidate's effect is reported beside the card's plausible effect, with how many cases its change moved past the base's own run-to-run spread. |
| Confirm | Survivors on the held split of levels whose env declares `protects`, run only through `cast env run --split held`, whose result carries scores on hashed ids; a held failure is recorded as a fixed phrase, never the runner's words. The base runs there twice, before and after the candidates, and each candidate is read against their mean with the wider of dev's and the held A/A spread, so drift over the sitting (live or inline regrades) is not read as gain. A candidate whose held change moves far more of its cases than its dev change did is reading the held runs' drift and is not confirmed. A dev gain that does not hold there is logged as overfit against the candidate. A climb with no held split confirms nothing and stops. |
| Guard | Best held delta first: the checks gauge pinned plus any the goal names now (an L0 check: no case worse; a `role = "check"` env: its mean over the cases both sides scored may move against its `direction` by at most its `tolerance`), and the eval command of the line profile committed at the base, with `cast line eval-result`. The command is read the way it runs: each path under the `cd`s it makes, from the directories of the scripts it already reached (a wrapper that changes directory and runs the command after its `--`), or as the one file at the base whose path ends with it (a `$project_path` filled in for another directory), and the gate runs on the tree's copies of those files. A candidate is refused when it changes a file that command starts: a script and its directory, followed through package scripts (`bun run eval` pins package.json and the script `eval` runs). Every candidate is refused when the command names a script none of that reaches, and the refusal names it. An L0 check whose env declares no `protects` fails the guard. Each eval run counts against the budget, and runs under a limit: `[guard] timeout_s` in the product repo's climb.toml (in its .codecast directory) at the base, else twice the longest gate this climb has run, else two hours. A gate past its limit is stopped with its whole process group and reads as void (Hold checks it again; it never passes), naming the command and its last output; an env check past its `timeout_s` is void the same way. A check is judged on the cases the base scored: a case the base never scored has nothing to be worse than, so cases only the candidate scored never hold it (a climb that fills empty lists scores more of them). A void verdict (an outage, a capped pool, a case the base scored left unscored on the candidate, a gate that could not score) is pending, never a pass; a case the base scored that the candidate dropped with nothing unscored fails: a real failure among the cases both sides scored still fails, and otherwise promotion waits on the best survivor's verdict, with no lesser survivor promoted past it. The first to pass is promoted; each refusal is logged. |
| Hold | Guard's void verdict parks the run here (no slot, no session): the void checks re-run every 3 hours for up to 3 days (`cast climb guard --hold`), each run counted against the limit, until a real verdict lands. Then the run goes on as Guard would have, or stops at Record when the hold runs out. |
| Mode | How the repo ships a promoted change, from the product repo's climb.toml (in its .codecast directory) at the base, `[promote] mode`. `line` is for a product that ships approved work live and runs a split test only when a person asks: Promote files the winner as a subtask for the product's own change line, with `--predict` and the evidence, and Filed puts the computed record on it. The line then builds, reviews and ships it, and its decision is the person's. `experiment`, the default, goes to the decision below. |
| Promote, Evidence, Decide | Promote files the change as a subtask of the climb's task under the climb's goal, with `--predict` (read back after ship, predictedEffect.ts). It records the subtask with `cast climb promote`, which replays the stations first, and writes the question proposing a holdout experiment sized by `cast climb experiment`: the weeks a 50/50 test needs for the predicted lift, from the metric's own reading (`metricReadings` over the goal's live series, the one `cast goal show` prints), so its level, pooling, cohort periods and observed spread are the goal page's. Decide asks that question with the climb's computed record as its document and Promote's case after it. Start opens the recorded task; Drop closes it. Nothing reaches production without the answer. |
| Record | Every end passes here: the summary (tried, refused, separated, overfit, guard refusals, undecided, cost against budget, outcome) goes on the goal as an update and on the task. When the climb screened anything, the record carries a Hypothesis line: the best survivor's effect against the card's plausible effect, read as held (half or more), weaker than expected (down to a sixth) or refuted (under that, or nothing separated). The next Frame starts from it. |

Every env run is checked against the budget before it starts and counted
after; a run the budget cannot cover stops the climb (exit 4) with the
undecided candidates named. Spend counts every run the climb started,
failed ones included at their declared cost, and a run that failed is never
run again.

No decision rests on a file an agent could write. Agents and candidate code
run as the same user as the climb, so the climb's state (under the CLI's
directory, sealed against casual edits, `climb/store.ts`) is only a cache of
which filed attempt answers which run. Every station reads those attempts
back from the registry and checks that each is the run it claims: env,
split, candidate label and sha, version, filed under the climb's task after
it began, or reused from before it. Each station then replays the stations
before it from those attempts, so a forged status, cut or budget changes
nothing, and an attempt that is not the run it claims stops the climb. The
installed packages the grading files import (found as Node resolves them,
from the importing file up) are fingerprinted at gauge by what can change a
grade: each one's name and version and its lockfile integrity entry, never
the files other sessions touch in a shared checkout. When that changes during
the climb (a reinstall, an upgrade), the base is measured again on the new
state, the old runs keep their cost on the ledger, and no comparison mixes
the two. A station that fails says what the climb has filed so
far, or that it filed nothing, and a run the registry refuses to file is
counted with the registry's reason. A failed run is reused only within the
attempt (the flow run) that made it, so its stations replaying one another
pay once; the next run of the flow runs it again, since the env may have been
fixed since, and the old failure keeps its cost on the ledger. A climb that
stopped, or never kept a level, starts fresh when the upstream base has moved,
and its old state is kept beside the new one. `cast climb where --dir
<run_dir>/climb` prints where a climb's state lives, and `cast climb reset`
sets it aside so the next run starts fresh. What stays on trust is the registry
itself: it records an attempt's candidate, sha and task as the filer states
them, and agents file as the same user, so an agent that reads the seal's
key can file a result it made up and point the cache at it. Closing that
needs filings signed by a credential agents cannot read: a separate OS user
for the climb's stations, or a run credential the server checks. Also on
trust: the eval gate's verdict per candidate and the spend the cache
records. Runners start without the run's values in their environment.
The held split's own protections are the registry's (envCases). Runs already
filed are reused, so a resumed run pays for nothing twice.

## FL11. The intent check

`intent` (`templates/intent.cast`) is a segment in the pool that answers one
question: did the person who started the run already say, in their own words,
that this change should ship? A flow composes it where a card would otherwise
ask that person (Union's land runs it before a mechanism or gate-edit card)
and routes on its exit, `cleared` when the starter's word covers the change
and `ask` otherwise. It writes nothing to the run.

Asker reads, in the order they were said, the words people typed into the
sessions the change came through and their answers to the decision cards
those sessions and the task asked (an answer a person gave on a card counts
like a line they typed; an agent's or a policy's does not), and the run's
starter (`cast flow asker $change_conversation --task --run`: the chain walk
and provenance of `originator.ts`). Only a message's typed part counts
(`typedPart`): what a composer send handed over as typed
(`pending_messages.typed_text`, never the quotes, mention context or
attachments folded around it; a joint send hands over none, and merging two
queued rows clears the mark), or a terminal line with its `<pasted_content>`
blocks and mention context taken out, a slash command as `/name args`. A
short paste the terminal took as typing, or text pasted into the composer
box, cannot be told from typing and counts. A terminal line counts only in a
session the daemon marked `--interactive` (Claude Code's `cli` entrypoint,
Codex's terminal UI or VS Code extension), read from the transcript head at
create and, for a session recorded before the mark, on its next sync
(`conversations.markInteractive`, which only adds that mark to the caller's
own unmarked session); the Agent SDK, `-p`, any other agent and an unmarked
session read as program, as do a brief, a relay, an agent's "approved", an
echo whose words a queue row of the session holds (read only from the day
around the line), and a session another one handed its work to.

Change records the commit it diffs (`$run_dir/intent-head`) and reads the diff
as the judge does. Read, a model call (`intent/asker.md`, held by the
`intent-read` evals), answers `{ship, session, line, card, quote, in_scope,
why}`: an explicit ship word, an accepted plan that ships, a /drive request or
a card answer choosing to ship, from the starter, not taken back later, and a
change inside what they asked for. Verify then sends `cast flow intent-verify
--cite <session>:<line>` (or `--card sd-N`) `--quote --head --record`, and the
server is the gate (`/cli/intent/verify`, `verifyCitation` and
`verifyCardCitation`): the caller is the run's own runner; the cited line or
card was said on the run's change chain (walked from the run's spawner and the
session that filed its task, as the run's starter may read them; task
comments name no anchor) or, for a card, on the run's task; a line is typed,
a card was answered by a person; that person is `run.user_id` and no agent
account; the line's typed part or the card's answer holds the quote with
whitespace folded; and no person answered other than Ship on the task's Ship
cards after it was said (a composer line is dated by its submit, a card by
its answer). The check guards against honest misreads, not a token holder
forging a session's links. Verified, the server comments on the task `<name>
said to ship: "<quote>" (<cite>), checked against the record.` and the station
writes `$run_dir/intent.json` (`{starter_id, starter_name, cite, quote,
head}`, the cite `<session>:<line>` or `card:sd-N`, the starter the server
checked and the commit Change diffed) for the composing flow to read. Every
other ending is `ask`, after one task comment saying why (`Intent asks a
person: ...`: the model's why, the server's refusal, or the failure): no
session behind the change, a branch that does not resolve, a failed script
or call, an answer that is not JSON, ship false, out of scope, or a refused
citation. Asker removes any earlier intent.json first, so a leftover file
never reads as a verified word.
