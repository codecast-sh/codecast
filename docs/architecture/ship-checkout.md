# Shipping a shared checkout

Many agents edit one checkout at once, and everything they leave uncommitted
ships in one pass while they keep working. `cast ship checkout` is that pass;
`cast land level` and the daemon's level sweep keep the checkout on top of its
upstream between passes. The code is in `packages/cli/src/land/`.

## Why the usual tools do not work here

A shared checkout is never clean for more than a few seconds. `git pull
--rebase` refuses a dirty tree; `git stash` sweeps up other sessions' work and
races the watchers that rewrite generated files; `git reset` moves the diff
base under sessions that are mid-edit. Assembling commits in a separate
worktree avoids all three but leaves the shared checkout behind its upstream,
with its landed edits still showing as uncommitted.

So nothing here rewrites the shared tree except the level, and the level only
writes files nobody in the checkout has changed.

## The pass

| Stage | What happens | Where |
|---|---|---|
| Freeze | The whole working tree becomes one git tree through the turn snapshot's private index. What ships is this tree: an agent writing a second later ships next time. | `commitGroups.ts`, `treeSnapshot.ts` |
| Attribute | Each changed file goes to the session that wrote it last, read from the transcripts in the sync ledger (and workflow transcripts under their parent): Edit and Write calls, shell commands that write (sed -i, a python heredoc, a redirect, mv), Codex patches. Incremental: each transcript is read once, then only what it appended. | `attribute.ts` |
| Plan | One group per session, titled from the session, with its state, whether it is mid-turn and its last words. Files named or shaped like credentials are held, and so are stale copies: a file whose content is an older version of itself (it never caught up when HEAD moved), whose diff would revert the commits since. The plan is written to `.git/codecast/ship-plan.json` and pins the frozen tree. | `shipCheckout.ts` `makePlan` |
| Judge | An agent (the `/deploy` flow, or a person) reads the plan: holds a group that is half done, splits or merges groups, rewrites messages. Optional: without it the default plan ships. | |
| Commit | Each shipping group becomes a commit built from the frozen tree in a private index, with the session trailer when the session is team visible. | `buildCommits` |
| Replay | The checkout's own unlanded commits, then the new ones, are rebased onto upstream in the object store (`git merge-tree --write-tree --merge-base`). A commit upstream already holds is dropped. | `replay.ts` |
| Import gap | When groups are held, a shipped file that imports a held file stops the pass: the tree would typecheck and the commit would not. | `importGaps` |
| Level | The checkout moves to the result. Files equal to the result are only re-indexed; files nobody touched are rewritten; files edited since the freeze are merged three-way from their frozen content, so typing during a ship is kept, never overwritten. | `level.ts` |
| Check | `[ship] check` runs in the checkout, then the test files the pass changed. `CAST_SHIP_BASE` names the upstream commit the pass replayed onto, so `cast check --changed-since $CAST_SHIP_BASE` checks only the programs holding a changed file. Errors only in files the pass left out are ignored. With more projects than the machine's watcher cap (6 here, 7 projects), a pass touching all of them cold-starts one or two programs, about two minutes. | `runPlan` |
| Deploy, push | `before_push` deploy steps whose paths match, then the push. If upstream moved meanwhile, the commits replay onto it and the checkout levels again. Then `after_push` steps. | `runPlan` |

On the real checkout (768 files, 43 sessions) a plan takes under a second warm
and the pass about 6 seconds before the check and deploys.

`mode = "pr"` (the default) pushes a branch and opens a pull request instead
of pushing the default branch, and leaves the checkout's branch where it is.

## Stale copies

A checkout's HEAD can move while some of its files stay behind: it lagged
upstream and caught up without rewriting them, a per-file level skipped them,
a worktree's patch was applied on an older base. Against HEAD such a file
reads as an edit that removes what later commits added, and shipping it
replays those removals onto upstream as reverts (union-mobile, Nov 8: a
73-commit batch undid e7fb2f23cc across eleven files). `land/staleCopy.ts`
streams HEAD's recent history of the changed paths (`git log --raw -p -U0`,
3000 commits or 60 days) and holds a changed file in the `stale` group when:

- its frozen content is exactly an earlier version of that path;
- it is absent, no session removed it, and a commit in the window added it;
- it resembles an earlier version more than HEAD's, and most of the lines it
  removes were added after that version;
- a hunk of its frozen diff undoes a commit hunk whole: every line the commit
  added is gone (and did not move to another changed file), what it removed
  is back, and the frozen hunk adds no more than a genuine edit beside it
  accounts for. Big real edits around the stale part do not hide it.

The group's note names the commits each file would revert. Replayed on the
Nov 8 batch (its first commit's parent as HEAD, its last tree as the freeze)
it holds 24 of 926 files, every file that lost e7fb2f23cc among them.

What it does not hold: removing part of a commit hunk (a function deleted
from a file a recent commit created, which is how refactors read), rewriting
lines a commit added, a file's creation, and anything older than the window.
What it holds that may be meant: a session deliberately reverting a recent
commit's hunk or restoring an earlier version of a file. A held path ships
once a person moves it to another group.

## Configuration

`.codecast/workspace.toml`:

```toml
[ship]
mode = "direct"        # or "pr"
check = "cast check --changed-since $CAST_SHIP_BASE"   # the projects this ship touches; "" skips
tests = true           # run the test files the pass changed
level = true           # the daemon keeps the checkout level with upstream

[[ship.deploy]]
name = "convex"
when = ["packages/convex/**"]
run = "packages/convex/deploy.sh --typecheck=disable"
stage = "before_push"
```

A deploy step runs in the checkout, so it deploys what the checkout holds,
edits the pass left out included. For Convex here that is deliberate: sessions
deploy their uncommitted backend work to test it, and deploying only the
shipped commit would remove functions they are using. A held group that
touches deployed paths therefore still reaches the backend.

## The level sweep

Every minute the daemon fetches each checkout a session runs in and, when the
repo set `level = true`, levels it onto upstream (`land/levelSweep.ts`). It
stands back while a ship holds `.git/codecast/ship.lock`, during a rebase or
merge, off the upstream's branch, and when the checkout holds commits
upstream lacks. A checkout whose own commits upstream already holds by
content (pushed from a detached worktree) is levelled: `git cherry` marks
them, and that state used to block every Convex deploy from the tree.
`cast config level_checkouts_enabled false` turns the sweep off on a machine.

## Fix forward

A pass checks only what is fast; CI runs the rest after the push. A standing
`check_failed` trigger on the GitHub CI source wakes a session with the
failing run, maps each commit in it to its session through the
`Codecast-Session` trailer, and either hands the failure to that session or
fixes it and ships again.
