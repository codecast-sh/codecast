# Cloud workspaces

`cast spawn --cloud [host]` runs each prompt in a separate native git worktree on a registered cloud host. `--cloud` implies isolation; `--subagent --agent codex` keeps the workers nested under the caller.

```sh
cast spawn --cloud i-084309c56a91e15ff --agent codex --subagent - - - <<'PROMPTS'
First task
---
Second task
---
Third task
PROMPTS
cast hosts ls --json
```

The existing host is woken over AWS and reached over SSH. The repository is refreshed from the real remote's main branch. If the host cannot authenticate to the git remote, the laptop fetches fresh main into a temporary repository and transfers it over SSH; it never rewrites the laptop's branches or index. Dirty existing remote checkouts are refused rather than discarded.

Manifest-listed private files travel directly over SSH, not Convex. Each worktree receives a private input snapshot, including local manifest overrides, without modifying the shared checkout. Healing uses that same snapshot. Setup and dependency installation run on the host. `PORT_WEB` (or the corresponding manifest port name), `CODECAST_PORT_WEB`, and the worktree identity are available in new and resumed sessions. Use the allocated port explicitly when starting a development server.

Port reservations are persisted before setup begins and coordinated across processes and registered repositories. A workspace reserves its ports even before anything listens. Deleting the workspace releases the reservations. Lock owner metadata is published atomically; dead or unreadable owners are never automatically reclaimed. Drain old reservation writers during an upgrade: they share the lock namespace but still have their old age-based reclamation behavior.

Creation, healing and destruction share per-workspace operation ownership. A concurrent same-name operation is refused; another workspace can proceed independently. Ordinary failures release ownership for healing. An abruptly killed owner fails closed: setup children might still be running, so inspect and stop those children before removing the operation file named in the error and retrying. A running server is an advisory warning, not a failed workspace contract. Input staging establishes repository-local Git exclusions for Codecast's worktree and state directories, without editing the project's tracked ignore file.

Cloud Bun installs use a per-workspace cache with the global store disabled. Native git worktrees share the repository's object database, but installed dependency files must not share writable storage with another task. This is working-directory and dependency separation, not a security sandbox: agents running as the same Unix user can deliberately access other paths.

Kill/dismiss cleanup preserves dirty trees, unpublished commits, and worktrees still used by another session. Unknown ownership fails closed. Temporary account and agent restarts must not collect workspaces. Manifest teardown commands are responsible for stopping separately launched development services; killing a session does not promise to find arbitrary detached servers.

## Verified on the existing AWS host

The existing 12GiB volume was expanded to 32GiB, without creating an instance. One three-prompt invocation created these real Codecast installations:

| Session | Worktree | Port |
| --- | --- | --- |
| jx77bkw | cloud-bc9163 | 3221 |
| jx72ss5 | cloud-5b222d | 3241 |
| jx79tnw | cloud-1493ee | 3261 |

All three had ready workspace records, separate caches, and simultaneous HTTP 200 responses/listeners. A deliberate write into A's installed `nanoid` package left B and C unchanged; the original bytes were restored. Worktrees measured approximately 2.1/2.0/2.0GiB after A started the web development server, with one shared 1.3GiB git object database. These are not production-build size measurements. The filesystem retained approximately 13GiB free.

Worker A used the host's own `cast browser` and `cast image` to capture the rendered public Codecast page on port 3221. The screenshot covers A only; the other two ports are evidenced by the HTTP/listener checks. Authenticated UI functionality is a separate check.

`cast kill jx79tnw` removed C's worktree and private state/cache at 01:38:07 UTC on September 5, preserving A and B. Earlier B cleanup ran on an older guard and retained its tree; C is the corrected cleanup proof.

The host was explicitly stopped at 01:40:26 UTC. Trigger tr-500 queued at 01:43:32; the laptop daemon woke the host, and A responded at 01:44:32 in its preserved worktree with port 3221. This demonstrates laptop-mediated wake only. A separate journal entry records automatic idle shutdown.

In the current local web build, the cloud toggle selects Cloud Linux and locks isolation on. A's header identifies the cloud host and worktree. This does not establish production rollout: the older production artifact lacked the toggle and failed opening A with `ChatOn is not defined`.

## Server-side wake verified in production

The founder approved a dedicated server-side AWS identity. The backend now implements allowlisted wake requests and dispatches due triggers bound to those cloud conversations. `cloudWake` records a lease, bounded retries and the AWS request ID on the existing device row. An EC2 response means the instance is starting; a subsequent device heartbeat is required before the request is considered answered.

For configured owner/device pairs, laptop wake responses and daemon trigger claims are suppressed. Non-cloud jobs keep the existing daemon scheduler. Removing the allowlist restores the old laptop-mediated behavior; no local daemon reload is required. New `--spawn` triggers still use the existing daemon path: this server dispatcher is for triggers bound to existing cloud sessions.

The production backend and allowlist were deployed through the coordinated release on September 5. Two new bound triggers, tr-519 and tr-520, woke the stopped host and resumed the original session jx77bkw. It executed from `cloud-bc9163` with `PORT_WEB=3221` at 17:39:04 and 17:45:00 UTC, retaining native thread `01a06f28-bfa4-7700-8915-aa9d33d7eaf4`.

The second cycle explicitly checked both laptop paths while work was waiting. At 17:44:22, tr-520 was due and still scheduled before and after the laptop query, but absent from `getDueTasks`; `claimTask` returned null. At 17:44:36, an actual laptop heartbeat returned `wake_devices: []` while before/after server records still had an unanswered cloud wake stamp and an old remote heartbeat. Unrelated laptop fleet jobs continued: laptop mediators were excluded for this target, not shut down globally.

Server logs record the trigger dispatcher as `caller: Cron`, with the original conversation and a stable pending-message client ID. CloudTrail attributes both StartInstances calls to the dedicated `codecast-cloud-waker` IAM user from the server address, with request IDs matching the backend audit exactly. No laptop StartInstances call or SSH preparation was used for either wake. A later `cast hosts ls` used SSH only to inventory the already verified host and retained worktree.

Production rejects wrong-owner and wrong-device claims, an arbitrary instance argument, and public invocation of the internal wake action. The dedicated key's real AWS DryRun allows the approved instance and denies a different existing instance. Independent review, 221 focused backend tests, and release-owner combined backend/Linux/typecheck gates passed. See `infra/aws-cloud-waker/README.md` for rollout and rollback.

Production client cloud-toggle/header/fork checks remain part of the coordinated web release; this backend proof does not claim those client rollout checks.

## Deferred storage optimization

Writable shared package symlinks were tested and rejected: one workspace's package mutation appeared in a sibling. Reflinks were unavailable on the host's ext4 filesystem. An OverlayFS proof isolated writes using a read-only lower layer and separate upper layers, but a production implementation needs per-workspace mounts, cleanup and cache-version lifecycle. That optimization was deliberately not built. Private dependencies and sufficient disk space are the baseline.

## Home mirror

The laptop supplies personal agent context and project documents to cloud hosts. Discovery is recursive and independent of Git ignore rules: instructions, overrides, working notes, rules, skills, plugins, prompts, hooks, scripts and their portable support files travel together. `AGENTS.md` and the `CLAUDE.md` symlink are also tracked in this repository, so fresh clones carry its development rules.

| Source | Coverage |
| --- | --- |
| Personal agent directories | `.claude`, `.codex`, `.gemini`, `.grok`, `.opencode`, `.agents` and `.config/opencode`, including shared skill symlink aliases and portable plugin content |
| Project context | Nested instruction files, Markdown and other text documents, agent configuration, `.mcp.json`, docs/scripts/support directories and referenced files, including ignored and untracked files |
| Supporting context | In-home file references, relevant ancestor instructions and Claude project memory directories; transcripts and process state are excluded |
| Git preferences | An allowlisted global configuration block and global ignore file; host Git identity and access remain owned by host provisioning |

Symlinks are resolved into regular files at their logical destination, so every agent sees its own skill namespace. Cycles terminate; references and resolved paths use the same exclusion and size checks as ordinary files. Portable text receives home and project path rewrites. Binary support assets retain their bytes. macOS commands and paths can still require host tooling; copying a script does not install its interpreter or make an Apple framework available on Linux.

Credentials, session transcripts, databases, sockets, caches, dependency installations and native executables are excluded. Structured configuration is scrubbed of credentials and provider routing before transmission. Portable MCP definitions are retained; their authentication and host dependencies need the provisioning path. Explicit include paths cannot bypass the denylist. Inventory or parse failures prevent a success report, and the 256 MiB cap fails with a diagnostic instead of silently truncating coverage.

Codecast-owned snippets, hooks and settings remain host-managed. The receiver preserves Claude authentication environment pins from `~/.codecast/mirrored-claude-env.json`, Codex project trust tables and unrelated host configuration, then runs the host refresh step. A failed refresh leaves the mirror incomplete. Files are written atomically as `0600`, or `0700` when executable, without following destination symlinks.

The receiver stores the source generation and the bytes it actually wrote in `~/.codecast/mirror.json`. Later updates reconcile against that baseline. Removed source files and configuration keys are removed only where the mirror still owns them; host edits remain in place and are reported as conflicts, including when both sides changed. The sender never labels a partial apply or conflict current. This is a one-way context mirror; cloud edits are not copied back to the laptop.

Project source-to-target mappings live in `~/.codecast/browser/mirror-projects.json`. Repository registration happens after checkout creation, and worktree registration happens before the agent starts. Periodic refresh applies context to registered targets without resetting their source code or running dependency installation. With mirroring enabled, an initial sync failure stops placement rather than starting an agent without its instructions. Disabling mirroring explicitly opts out of that requirement.

The sender checks for laptop changes every minute and verifies remote file bytes, type and mode every 30 minutes. It serializes pushes, retries failures with backoff, and never wakes a sleeping host. A matching local generation avoids an upload on the fast path; verification checks the destination itself, not merely the saved receipt. The scheduler can be stopped and its active transfer settled during shutdown.

```sh
cast hosts sync --dry-run
cast hosts sync
cast hosts sync i-084309c56a91e15ff --take-over
cast config cloud_mirror_enabled false
cast config cloud_mirror_exclude ".claude/skills/private-*/**,.codex/prompts/**"
cast config cloud_mirror_include ".dotfiles/skills"
```

`cast hosts sync --dry-run` reports files, exclusions, scrubbed settings and compatibility warnings. `cast hosts ls` reports the last sender result. Another laptop's ownership requires explicit `--take-over`; a different user or target home is refused.

File freshness and loaded instructions are separate. An agent that is already running may retain the instructions and configuration it read at startup. Sync updates its files without forcibly restarting its work; start a new session when a changed instruction or configuration requires a reload. Skill hot reload depends on the agent. A verified disk generation is not a claim that every active model has re-read it.
