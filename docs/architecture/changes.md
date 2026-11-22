# Changes: one object from edit to live

A **change** is any work heading to production, whatever carries it: edits
still uncommitted in a checkout, a branch (in a worktree or pushed, with or
without a pull request), a shared checkout's pass, or a commit on main. Every
surface that names one draws it the same way: one chip whose track says how
far it has gone and whose last word says what is happening now. Sections are
CH1 onward so code can cite them.

## CH1. Five stages

| Stage | Done when | What it reads |
|---|---|---|
| Work | the change has left the checkout: pushed, or handed to a ship pass | checkouts (pipeline.md PL6: uncommitted paths by writer session, ahead of main), the session's state |
| Check | CI and review passed on the head that lands | the pull request's checks and review, else main's CI on the commit |
| Land | the change is on main: merged, pushed or replayed by a pass | `commits.main_at`, `pull_requests.merge_commit_sha`, GitHub's auto-merge |
| Deploy | a deploy carrying it has gone live on every target it touches | deploy reach (deploys.md DP16) |
| Live | every touched target runs it | deploy reach |

The stages never change order or number, whatever the vehicle, so a reader
learns one track. A stage a vehicle skips (a direct push has no review) is
drawn passed and says so on hover; CI that ran after landing reads as Check
with "after it landed".

## CH2. Now: one word, one tone

Every change has exactly one **now**: the stage that holds it and the state
it is in there. Its tone is the same on every surface:

| Tone | Means | Examples |
|---|---|---|
| yellow | in motion, nobody needs to act | editing, checking, landing (auto-merge), deploying 6m |
| muted | waiting its turn, or on whoever ships it | queued, not live yet, not shipped, draft |
| blue | a person must act | ready to land, needs review |
| orange | sent back to the session that wrote it | changes asked, conflicts, behind main, rolled back |
| red | failed and stopped | checks failed, deploy failed |
| green | live everywhere it goes | live |
| dim | not going anywhere | closed, replaced, abandoned |

Failure pops: a red now wears the strong tint and heavy glyph deploy pills
already use. One separator, `·`. Times are elapsed while in motion
(`deploying 6m`) and absent once settled.

## CH3. The chip

`[vehicle] name  ▪▪◉○○  word`

- **Vehicle glyph**: branch (whether or not a worktree holds it or a pull
  request names it), pull request (when the reference is `#N`), commit,
  edits (one session's uncommitted work), pass (a shared checkout's bundle).
- **Name**: the branch, `#N`, the short sha, the session's title, or
  `<folder> · N sessions`.
- **Track**: five pips. Passed stages solid neutral, the now pip in its tone,
  stages ahead faint. A live change is five green pips; nothing else is.
- **Word**: the now (CH2), at most three words plus a time.

The hover card is the whole journey: each stage with its one line (who wrote
it and how much, which checks, what merged and when, each target's deploy),
the writer sessions, and links to the pull request, run and deploys.

## CH4. Where it draws

- **Messages**: a branch name in inline code, written with a `/`
  (`evals/budget-checks`), draws the chip when the repository knows it: a
  checkout reports it, a pull request heads from it, or GitHub lists it. A
  bare word is never read as a branch: too much inline code is one. GitHub
  lists a repository's newest hundred branches only, so when the list was cut
  short a branch-shaped name none of these hold is compared with the default
  branch on its own (at most eight names a conversation), and draws as a
  pushed branch when it has commits main lacks. A pull request or commit
  reference (`owner/repo#N`, `owner/repo@sha`, `#N`) keeps its pill and its
  hover card, and after its name draws the same track and word the Branches
  page gives it (`useRefLifecycle`); a commit says only where it stands in
  production, so it draws them once its deploy reach is read.
- **Branches page**: the lifecycle grid (`ChangeBoard`): a row per change,
  the five stages as columns with one track across them, each cell's two
  words under its slice, grouped by who acts next: Needs you (red, blue, and a
  rollback), Moving (yellow, orange), Waiting, Live, then Quiet and Closed
  folded. A change goes quiet when nobody's work has touched it for three days
  (a session's write, a push, a commit); a landed change, a failure and a
  person's turn never do. Below
  the grid, every branch GitHub lists, each with its chip.
- **Deploys page**: "On its way" in each target's pane: the same grid,
  without Live and Closed, for every change of that repository not yet on
  main. What has landed and waits to go out is "Waiting on main", below it.
- **Phone**: a pull request or commit pill draws the same track and word, as
  text after its name. A branch name in a phone message stays code: the
  phone's transcript holds no repository's changes to find it in.
- **Motion**: none. A chip sits in transcripts and list rows, which run no
  infinite animation (CLAUDE.md typing budget): a change in motion wears its
  tone, and its grid slice static stripes.

## CH5. The rule and its facts

`packages/web/lib/changes/lifecycle.ts` turns a change's facts into its
stages and its now. It is pure with relative imports, so the phone's pill
reads it as the web does, and it is the only place a lifecycle word or tone is
chosen. `lib/changes/pullRequest.ts` reads a pull request into those facts for
the grid and both pills alike. `lib/changes/assemble.ts`
builds those facts from what the store already holds: checkouts (pipeline.md
PL6) for edits, worktrees and a shared checkout's pass; pull requests for
checks, review and merge; GitHub's branch list for pushed branches; the deploy
targets' queues for commits on main; deploy reach (deploys.md DP16) once a
change has landed. No server function of its own: a change is a reading of
rows that already sync, plus the existing compare for a branch a message names
that none of them hold.

A change flow run's own states (a person's call at Decide, the session fixing
what Review found) are not drawn: a run row does not record its branch, so a
flow's change reads by its pull request.
