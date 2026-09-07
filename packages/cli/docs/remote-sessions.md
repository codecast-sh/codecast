# Remote Sessions: Move to Mac

Move a live Claude Code session to a remote Scaleway Mac mini and back.
The remote Mac is "just another device" — same daemon, same JSONL sync,
same web visibility. The session continues on the Mac exactly where it
left off, including conversation history, working tree, and browser substrate.

## Quick start

```bash
# Move a session to the Mac (worktree-only)
cast remote move <sessionId>

# Web-inject a message (daemon auto-delivers to the Mac session)
# → just send it from codecast.sh like normal

# Bring it back
cast remote back <sessionId>

# One-shot prompt on the remote (without full move)
cast remote push <sessionId>          # transfer worktree + transcript
cast remote run  <sessionId> "msg"    # drive via print mode
cast remote pull <sessionId>          # bring changes back
```

## Spawn on the cloud host

A move carries an existing session to the box. A cloud spawn starts a fresh
one there, in its own worktree, from the same manifest local worktrees use:

```bash
cast spawn --cloud "port the v1 routes" "write the migration"   # two worktrees, two port sets
cast spawn --cloud i-0123456789abcdef0 "…"                        # name a registered host
cast spawn --cloud --subagent "review the diff"                   # nested under this session
cast fork --cloud "try Redis" "try Postgres"                      # branches run on the host
cast hosts                                                        # hosts, sessions, worktrees, cost
```

What happens, in order (`packages/cli/src/cloud/prepare.ts`):

1. The host is woken if asleep (`ensureUp`), and its codecast device id is
   learned over SSH and remembered in `~/.codecast/browser/hosts.json`.
2. `/home/ubuntu/work/<repo>` is cloned when missing (bundle over scp, origin
   repaired to the real URL) and brought to `origin/<default branch>`: a fetch
   on the host, or a push of the laptop's `origin/main` over SSH when the host
   cannot reach origin. A dirty checkout there is never reset.
3. The manifest's `setup.copy` files (`.codecast/workspace.toml`) are copied
   into that checkout with rsync over SSH. Nothing goes through Convex.
4. Each task gets a worktree from the host's own `cast ws acquire --json`, so
   install runs there and ports are probed on the machine that binds them.
5. The row is created already pointed at the worktree and routed at the host's
   device (an ordinary `start_session`). The session sees `PORT_<NAME>` and
   `CODECAST_WORKTREE_*` in its environment, so `vite --port "$PORT_WEB"`
   binds the port it was given.

The web's "run in the cloud" toggle does the same through a local daemon:
the row is parked (`cloud_placement: pending`) and the daemon runs
`cast cloud start <conversation>` as a child.

Lifecycle: the host powers off when the daemon's activity stamp goes stale
(a dormant session no longer keeps it awake). Work queued for a sleeping host
stamps its device row; a local daemon sees `wake_devices` on its heartbeat and
boots it, and the session resumes from the worktree and transcript on the
host's disk. A killed or dismissed session's worktree is released when it is
clean and its commits are on origin; otherwise it is kept and logged
(`packages/cli/src/worktreeGc.ts`), on the laptop and on the host alike.

## Commands

| Command | What it does |
|---|---|
| `cast remote hosts` | List this device + registered remote Macs |
| `cast remote push <sid>` | Transfer worktree (git-over-SSH) + transcript + credential |
| `cast remote pull <sid>` | Pull back (git fast-forward, never clobbers; surfaces conflicts) |
| `cast remote run <sid> "msg"` | One-shot prompt on the remote (print mode, acceptEdits) |
| `cast remote move <sid>` | **Atomic live handoff**: push + prep + flip ownership + resume on Mac |
| `cast remote back <sid>` | **Reverse**: pull + flip ownership back + resume locally |

## Bulk migration (many sessions, either direction)

`cast remote move` / `back` move one session at a time from the machine that
runs it. To move a whole set — the laptop's sessions to the cloud host before
closing the lid, or the host's sessions back — use the batch rail:

| Where | How |
|---|---|
| Web | Settings → **Migration**: pick a destination, tick sessions, go. Progress narrates row by row. |
| CLI | `cast migrate start --to <device> [<short-id…>] [--label x] [--from <device>] [--project <path\|name>] [--all] [--dry-run]` · `cast migrate ls` · `cast migrate show <batch>` · `cast migrate cancel\|retry <batch>` |
| Inbox | ⌘-click / shift-click cards to select several; right-click → "Move N sessions to…", or ⌘K → "Move to machine…". A single card's menu has "Move to machine" too. |

Selectors AND together and resolve on the server (`sessionMigrations.createBatch`
`selector`): `--label` is your personal filing (buckets), `--from` a device,
`--project` a path prefix or a substring of the repo name (a worktree counts as
its repo), `--all` every movable session. `--dry-run` plans without writing and
names each skip and its reason — agents should run it first when the selector
is broad. The agent-facing recipe ships in the `forks` CLAUDE.md snippet
("Moving sessions between machines").

What happens per session (`packages/cli/src/migrate/runner.ts`, server side
`convex/sessionMigrations.ts`):

1. **Fence.** The conversation is marked `migration` — no daemon delivers into
   it; messages sent meanwhile wait as pending. A session queued deep in the
   batch is NOT fenced until its turn comes, so it keeps working normally.
2. **Wait for the turn to end.** A session that is producing (`working`,
   `thinking`, `compacting`) finishes its turn first, up to the batch's
   wait window (default 10 min; "Interrupt right away" is 0). A session stopped
   at a permission prompt moves at once — its answer could never arrive through
   the fence — and the prompt re-asks on the destination.
3. **Quiesce.** `quiesce_session` at the current owner stops the agent so the
   transcript on disk is final (mode `idle` refuses while a turn is running;
   `force` interrupts it once the window is spent).
4. **Transfer.** To the cloud: the same push as `cast remote move` (worktree
   snapshot over git-SSH, gitignored secrets, transcript rsync, credential);
   sessions sharing one worktree push it once. Back to a laptop: the laptop
   pulls the transcript and fast-forwards the worktree with the host's
   uncommitted work restored as uncommitted; a cloud-born worktree is created
   locally under the checkout of the same origin.
5. **Flip.** One mutation: owner + project path move, a targeted
   `resume_session` goes to the destination, `release_session` to the old
   owner, and the fence comes off — the queued messages belong to the
   destination the instant it owns the row. The agent gets the usual
   reorientation notice.

The work runs on an online LOCAL daemon (it holds the host registry and SSH
key): the source laptop for a move to the cloud, the destination laptop for a
move back. The daemon starts a detached `cast migrate run <batch>` and logs to
`~/.codecast/migrations/<batch>.log`. A runner that dies mid-row leaves a
fenced conversation; the server lifts fences nobody has reported on for 30
minutes and marks the row failed, so the session is served again where it
still lives.

## How it works

**Transfer**: git-over-SSH. The worktree branch is pushed to a clone on the
Mac (bootstrapped via bundle). Uncommitted changes travel as a WIP snapshot
commit. Gitignored files (.env) are scp'd via the manifest copy-list.

**Transcript**: the JSONL (`~/.claude/projects/<slug>/<sid>.jsonl`) is rsynced
into the Mac's project dir. `claude --resume <sid>` continues the conversation.

**Auth**: the CC OAuth credential is copied from the local Keychain to
`~/.claude/.credentials.json` on the Mac (plaintext file; the remote CC reads
it). The token is ~1h TTL; the move always copies a fresh one. For sessions
running >1h, re-push with `cast remote push`.

**Ownership**: a `devices` table in Convex tracks each machine. A session's
`owner_device_id` determines which daemon manages it. `move` flips it to the
Mac; `back` flips it to local. The single-owner invariant prevents both
daemons from managing the same session simultaneously.

**Daemon**: the Mac runs its own codecast daemon from source
(`bun run src/index.ts _daemon`), heartbeating as a distinct remote device.
A remote daemon only manages sessions it explicitly owns (safety gate in
`autoResumeSession` — never adopts unowned sessions).

## Setup (one-time per Mac)

1. **Provision**: Scaleway M1 Mac (24h minimum, ~€2.64/day). `cast remote provision` (or manually via Scaleway console + register in `~/.codecast/scaleway/hosts.json`).

2. **SSH key**: `~/.codecast/scaleway/<host-id>/id_ed25519` (generated at provision, registered with Scaleway IAM).

3. **Install toolchain on the Mac** (via SSH):
   ```bash
   # Claude Code
   curl -fsSL https://claude.ai/install.sh | bash
   # bun
   curl -fsSL https://bun.sh/install | bash
   # tmux (from source, no sudo)
   # (see scripts/mac-daemon-bootstrap.sh for the build)
   ```

4. **Transfer codecast source**: `git archive HEAD | gzip | scp` + `bun install --linker hoisted`.

5. **Auth codecast daemon**: copy your decrypted token to the Mac's `~/.codecast/config.json`.

6. **Bootstrap**: `bash scripts/mac-daemon-bootstrap.sh` (overlays CLI source, removes `daemon.js` shadow, starts daemon).

## Known constraints

- **24h minimum Mac billing** (Apple licensing — all cloud macOS, not just Scaleway).
- **Credential ~1h TTL** — move always copies fresh; for long sessions, re-push.
- **Worktree-only** — the bounded git branch makes the transfer reliable.
- **`daemon.js` shadow** — committed compiled JS shadows `daemon.ts` under bun. The bootstrap removes it.
- **First-run dialogs** — the Mac needs pre-seeded `~/.claude.json` (onboarding, theme, folder trust) or resumed sessions hang on interactive prompts. `cast remote move` handles this.

## Architecture

The Mac is "just another device":
- `device_id` derived from `~/.codecast/.machine_key` (unique per machine).
- Daemon heartbeats register the device + its local project roots.
- Sessions carry `owner_device_id` → single-owner invariant.
- Moving = flip ownership + enqueue `resume_session` daemon command.
- The Mac daemon resumes in tmux, syncs JSONL to Convex → visible in web.
- Web messages inject via the normal pending-message → daemon → tmux path.
