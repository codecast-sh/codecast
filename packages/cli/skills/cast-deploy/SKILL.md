---
name: cast-deploy
description: Ship everything in this checkout and deploy it everywhere the repository deploys. Pulls in work from every worktree, cloud host and parked branch, commits it all to the default branch by the session that wrote it, pushes, then sends every deploy target the repository declares and waits until each is live. Use when asked to deploy, ship everything, release, or push it all out.
argument-hint: "[targets to send by name]"
---

Ship the main checkout as it stands: every uncommitted change in it is committed to the default branch, pushed, and deployed everywhere the repository deploys. Everything goes, whoever wrote it and whatever state their session is in. A session that is mid-turn or waiting on input still has its current edits shipped; this is the person's call, not yours. Do not hold, park, stash or revert anyone's work, and do not ask which changes to include.

Bias to getting the code out. Unfinished, unreviewed or unapproved is not a reason to hold anything; your job is to make shipping it safe, not to judge whether it is ready. Safe means: nothing newer on the default branch is undone, no data is lost without a way back, the checks and gates run, and production can be rolled back in one command.

Other agents keep working in the checkout while you ship, so never stash, rebase, checkout or hard-reset in the shared tree, and never overwrite a file someone has edited. `cast ship checkout` does the mechanical part safely. The checkout's HEAD moves only by levelling it onto origin (below), which rewrites only files nobody here changed.

Where this repository deploys, in what order, and what each deploy waits on and does afterwards is the repository's own declaration, `.codecast/deploy.toml`, not something to work out here. `cast deploy --dry-run` reads it.

## 0. Bring everything into the checkout

Work that earlier runs moved out of the checkout ships too. Every `parked/*` branch on origin that the default branch does not yet contain is applied into the checkout as a three-way merge against the commit it was parked from (`git diff <base> <branch> --binary | git apply --3way`), so upstream changes since then are kept; delete each branch from origin once its work is on the default branch.

Every worktree on this machine and every cloud host ships too. `cast land scan --hosts --json` (`--repo <path>` if it reports another repository) lists them; apply each tree that holds work the default branch lacks, whatever its verdict (`ready`, `review`, `live`, `stale`), with `cast land diff <tree>` piped into `git apply --3way` (over ssh for a host). A `live` tree ships what it holds now and its session keeps working there. Three kinds of tree stay where they are. A `run` tree belongs to a flow run, which ships its change itself once a person decides. A `held` tree was marked by its session (`cast land hold`) to stay on its branch, with the reason in its scan line; leave it and its branch alone until that session or a person runs `cast land release`. A `superseded` tree's work is already in another tree in a newer form; it lands through that tree, and prune archives it.

Trees often hold successive versions of the same work, and the scan names a tree's `overlaps` when another landable tree changes the same files differently. Apply such trees one at a time, the most recent first, and run the scan again after each, so the next one is judged against what is now in the checkout. A conflict is resolved into one file that keeps the intent of both sides and compiles, under the "never undo the default branch" rail below; never leave both versions of a hunk side by side. Once every tree is applied, typecheck before planning: a tree that does not merge into a building checkout is fixed here, not shipped broken. If a host has no `cast land`, say so and continue.

## Safety rails

- **Never undo the default branch.** A file, or a hunk, whose change is an older copy of work the default branch already holds in a newer form (its diff mostly removes lines upstream added since its base, or re-adds code upstream deleted on purpose) is dropped from the commit, not shipped: that is not holding work, it is not reverting someone else's. Check with `git log --oneline <base>..origin/<default> -- <path>` when a diff deletes recent upstream lines.
- **Data has a way back.** A migration that only adds ships. One that drops or rewrites existing data (dropping a table or column, a destructive update or delete, a type change that loses values) ships only after a fresh backup of that database exists, taken the way the repository's instructions say; name the backup in the report.
- **Rollback is one command.** `cast deploy` records what each target ran before it (its previous deploy, dp-N) and the target's declared `rollback`; put the rollback for each production deploy in the report (`cast line deploy --target <name> --rollback --go`).
- **Secrets stay out** (below), and the checks, tests and gates always run.

## Level the checkout

The checkout's HEAD equals origin's default branch before you plan and again after you push. A HEAD left behind makes every later ship replay against a stale base, shows thousands of already-shipped files as changed, and lets old copies of files ship as reverts. `cast land level` levels it when every file merges cleanly. When it refuses, level it yourself against one pinned origin sha, file by file:

- A file nobody here changed, or one byte-identical to an older upstream version of itself, takes the upstream version; one upstream deleted, and identical to what was deleted, is removed.
- A file that is the current upstream plus edits stays as it is: those edits are someone's work.
- A file that is an older upstream version plus edits gets those edits merged onto upstream (`git merge-file`, with that older version as the base); resolve any conflict by hand.

Re-check each file just before writing it and skip any edited in the last few minutes. Then `git reset --mixed <sha>` moves HEAD and the index without touching a file. Reinstall dependencies and run the repository's codegen afterwards, so installed packages and generated files match the new lockfiles and sources, and typecheck. Levelled, `git status` lists only the sessions' real edits.

## 1. Plan

Level the checkout first. Then `cast ship checkout --dry-run --json` freezes the checkout and groups every changed file by the session that wrote it. Your job on the plan is only the commit history: split a group holding two unrelated changes, place unattributed files with the group they belong to, and write each message as a short conventional commit saying what changed. Every group ships.

The one exception is a live secret. The plan already holds files named or shaped like credentials; ship any you can see are not real secrets, and keep a real one out and name it in the report. Scratch output (logs, temp dumps) that clearly is not source belongs in `.gitignore` or `.git/info/exclude`, not in a commit.

Save the edited plan to the file the dry run printed.

## 2. Ship

`cast ship checkout --plan` commits each group, replays onto origin, runs the repository's check and changed tests, deploys what must precede the push, pushes, and deploys the rest, as the repository's `[ship]` table says.

Ship through the checkout. If `cast ship checkout` cannot replay, level the checkout and run it again rather than building commits somewhere else; if you did commit from another worktree, level the checkout onto what you pushed before going on. After every push, the checkout is level with the pushed head.

When it stops, fix the cause and run again. A type error or failing test in shipped work is fixed forward in place, the smallest change that makes it correct; never hold the file to get past it, and never skip the check. A conflict with upstream is merged keeping both sides. When a changed behaviour makes an old test stale, update the test to the intended behaviour. CI red on the default branch after the push blocks everyone: fix forward at once.

## 3. Deploy every target

`cast deploy` sends every target the pushed head moved past whose policy is `release`, each once the targets it goes after are live, and waits for the targets that deploy themselves on a push. Each send is a deploy (dp-N) whose steps (CI, send, live, finish) show on the Deploys page; read `cast deploy --dry-run` first so the report can say what was left alone and why. Targets named after the command (from the skill's arguments, or a person's ask) go out whatever their policy.

When a step stops, read the deploy (`cast line deploy show dp-N`) and fix the cause: a red CI on the head is fixed forward and pushed, then `cast deploy` runs again and sends only what is still behind. An eval gate or approval step that refuses goes to the person with `cast decide`, carrying the concrete change the gate saw and what each option costs.

If the repository deploys somewhere `.codecast/deploy.toml` does not declare (its instructions name a deploy script, an app store, a release workflow), deploy it by hand this time, then add it as a `[[target]]` so the next release and every change flow send it: its `run`, the paths it ships (`when`), how codecast reads what is live there (`live`), its `rollback`, `policy = "release"`, and `after`, `ci` and `finish` when it has an order, a CI gate or a follow-up. `cast line deploy targets --publish` publishes the declaration.

## 4. Release the trees

Once the push is on origin, `cast land scan --hosts` should read every tree you applied as `landed`; `cast land prune --hosts --yes` then archives and removes the landed, empty and stale ones. `live` trees stay, since a session is still in them, and `held` and `run` trees stay as well.

## Report

The commits pushed, each with the session it came from and the tree or parked branch it was brought in from; trees released per machine, and live ones left; every `held` tree, per machine, with the reason its scan gives; each target with its dp-N, the sha and version that went live, or what it was left alone for, and its rollback; any file kept out (a live secret) and why; any fix you made to get the check green; how far the checkout's HEAD is behind origin at the end (0), and `git status` at the end, naming files that changed after the freeze (other agents' new edits, left in place for the next run).
