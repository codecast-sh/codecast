# Turn snapshots: a true file history per turn

The transcript records the edits an agent made through its Edit and Write
tools. It does not see an edit made by a shell command, a formatter, a test
that rewrites a fixture, or a person in their own editor. The working tree is
the only ground truth, so the daemon records the tree itself at the end of
every turn. This is the one idea taken whole from Zed's Delta (its DeltaDB
records every edit from any source); codecast gets the same history from git
at a fraction of the cost, and the objects never leave the person's own
repository.

## T1. What is recorded

A snapshot is a dangling git commit of the checkout's working tree
(`packages/cli/src/treeSnapshot.ts`), built like the older sweep snapshot
(`wipSnapshot.ts`): `.gitignore` applies, so a secret git ignores never enters
one; the real index, HEAD and branch are untouched. Two things are new.

- **It chains.** First parent is HEAD, so every reader that expects
  `snapshot^` to be the base commit keeps working (restore, fast forward,
  `cast ws acquire --start-point`). Second parent is the previous snapshot of
  the same checkout, so pushing the chain tip to the hidden ref
  `refs/codecast/wip/<conversation>` publishes the whole history behind it.
  Trailers carry the branch, the chain depth and the time taken. The chain
  restarts every 400 snapshots so an abandoned tail becomes unreachable and
  git's own gc reclaims it.
- **It is indexed.** The server table `tree_snapshots`
  (`convex/treeSnapshots.ts`) joins a sha to the conversation and the turn it
  closes: `turn_completed_at` from the Stop hook, `changed_paths` and
  `changed_count` against the previous snapshot, `dirty`, `source` (turn or
  sweep), `checkout_key` (the hashed checkout root, so sessions that share a
  working tree are visible as such), and `took_ms`.

One snapshot describes one checkout, not one session. Every session whose turn
ended in the window gets a row naming the same sha.

## T2. Why it is cheap

Measured 2026-10-06 on this repository (7,798 tracked files):

| pass | at rest | load 250 to 700 |
|---|---|---|
| sweep snapshot before this change (index rebuilt from HEAD, every file rehashed) | 1.8 s | 170 to 198 s |
| full pass on the persistent index (stat walk, changed files hashed) | 0.18 s | 24 s |
| pass limited to named paths | 0.07 s | |

The persistent index lives at `<git dir>/codecast/wip.index`, seeded once by
copying the real index (its stat cache is what makes the first pass cheap).
`<git dir>/codecast/wip.head` holds the chain tip. On top of the index:

- nothing runs on the hook path: the Stop hook returns at once and the
  snapshot runs from a timer;
- one snapshot per checkout: turn ends within 1.5 s share a pass;
- adaptive: a pass over 5 s parks turn snapshots for that checkout for ten
  minutes; the 5 minute sweep still runs and now uses the same index;
- `wip_snapshots_enabled: false` in the config turns both off.

Under heavy load a snapshot can lag its turn by seconds and include the start
of the next turn. A rewind is therefore accurate to the turn, not to the
keystroke, and the table's `took_ms` says how long each pass cost.

## T3. Surfaces

- `cast diff <session> --turns` lists a session's snapshots with the ask that
  started each turn (cast read numbering) and the files changed; `--turn N`
  (or `last`) prints the diff a turn made to the tree, shell and hand edits
  included, fetching the wip ref when the objects are not local; `--stat` for
  the file list.
- `cast ws acquire <name> --rewind <session>[@<line>]` makes a worktree with
  the files as they stood at that message: the newest snapshot taken at or
  before it (`turns.ts` `snapshotAtLine`), as a branch at the snapshot's base
  commit with its edits uncommitted. `cast fork --at <line>` run in that
  worktree continues the conversation from that tree.
- `cast ws acquire --from <session>` (pickup) fetches the same ref and gets
  the chain with it.

## T4. Retention

Chain depth caps at 400. Objects are reachable only through
`refs/codecast/wip/<conversation>` locally and on the remote; when a session's
ref is deleted the chain is garbage. Blobs are written only for files that
changed since the previous snapshot, so a turn that touched three files costs
three blobs and the trees on their path.
