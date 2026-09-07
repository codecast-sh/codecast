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

The laptop is canonical for instruction files and agent config; every reachable host receives a one-way mirror of them so an agent on the box reads the same rules, skills, hooks and aliases as one on the laptop. One length-prefixed bundle travels over ssh stdin to the host's own `cast cloud mirror-apply --stdin`, which merges under `~/.codecast/mirror.lock` rather than overwriting.

What ships, by directory:

| Root | Mirrored | Never mirrored |
| --- | --- | --- |
| `~/.claude` | `CLAUDE.md` (user portion), `settings.json`, `settings.local.json`, `keybindings.json`, `agents/`, `skills/`, `commands/`, `prompts/`, `output-styles/`, `hooks/`, top-level scripts, `plugins/known_marketplaces.json`, the statusLine script | `.credentials.json`, `~/.claude.json`, `history.jsonl`, `projects/`, `sessions/`, `session-env/`, `shell-snapshots/`, `file-history/`, `backups/`, `cache/`, `todos/`, plugin clones and `installed_plugins.json` |
| `~/.codex` | `AGENTS.md`, `AGENTS.override.md`, `config.toml`, `hooks.json`, `prompts/`, `rules/`, `skills/` | `auth.json`, `*.sqlite*`, `sessions/`, `cache/`, `tmp/`, `skills/.system`, `plugins/`, `installation_id` |
| `~/.grok`, `~/.gemini`, `~/.agents`, `~/.config/opencode` | instruction files, config, skills, commands, hooks | sessions, OAuth credentials, history, `tmp/` |
| git | an allowlisted render of the effective global git config (aliases, `core.*`, `pull/push/init/rerere/color/...`) between `# >>> codecast mirror` / `# <<< codecast mirror` markers, the global ignore file. Read from the repo being prepared, so an `includeIf "gitdir:…"` profile resolves; the repo's own `.git/config` and system files are left out | `user.*` (owned by the host git setup), `credential.*`, `gpg.*`, signing, `url.*`, `include*`, `core.sshCommand`, `http.*`, `lfs.*` |

Codecast's own content is stripped on the laptop and again on the host: the snippet sections of `CLAUDE.md`/`AGENTS.md`, the five hook scripts, `~/.codecast/hooks/*`, the orchestration skill, agents and hooks. The host re-injects its own copies through `cast snippets-refresh`, the stable-context hook installers and the settings persistence pin, so nothing is duplicated or clobbered. Any key at any depth whose name looks secret (`token`, `secret`, `passw`, `api_key`, `credential`, `private_key`, `auth`/`auth_*`/`authorization` — not token *limits* like `MAX_THINKING_TOKENS`, not `author`), any value that looks like a token (`Bearer`, `sk-ant-`, `ghp_`, `AKIA...`, `-----BEGIN`, userinfo URLs), provider-routing env (`CLAUDE_CODE_USE_*`, `ANTHROPIC_*`, `AWS_*`, proxies, OTEL headers), `permissions.disableBypassPermissionsMode`, `apiKeyHelper` and friends, and every MCP definition (`[mcp_servers.*]`, `mcpServers`, `mcp`, `.mcp.json`) are dropped before anything leaves the laptop. Files named like keys (`id_*`, `*.pem`, `*.key`, `credentials*.json`) never ship wherever they sit; a *directory* with such a name (a skill called `id_generator`) is fine. Laptop-home paths are rewritten to the host home in config kinds and in the instruction files (`CLAUDE.md`, `AGENTS.md`); scripts and skill bodies are verbatim.

Merge rules on the host: `CLAUDE.md`/`AGENTS.md` become the laptop's user portion followed by the host's own codecast sections; `settings.json` is deep-merged laptop over host with the host's codecast hooks, `model`, `skipDangerousModePermissionPrompt`, the persistence env and any agent-auth env keys pinned; codex `config.toml` keeps the host's `[projects.*]` trust tables, `[mcp_servers.*]` tables (the laptop never ships its own) and `[features] hooks`; `~/.gitconfig` outside the marker block is untouched. Files land 0600 (0700 with the laptop's exec bit), new directories 0700. A bundle remapped for a different home path than the host's is refused (`other_home`).

Two stamps keep pushes cheap and safe: the laptop's `~/.codecast/browser/mirror-pushes.json` (per host address: last hash, last failure) and the host's `~/.codecast/mirror.json` (hash, source device, per-file kind + shas). A spawn, a move, a wake and the daemon's 60-second tick skip the ssh when the hashes agree; a host the laptop has no entry for (an AWS box wakes on a new address) has its own stamp read first, so an in-step host costs one `cat` rather than an upload; the 30-minute tick reads every host stamp and re-pushes on mismatch. A transport failure is retried when the local hash changes, on the periodic tick, or by `cast hosts sync`; a *refusal* is final for the bundle that earned it — nothing re-uploads it until the config changes or `cast hosts sync` / provisioning forces a push. A laptop that is not logged in (no `user_id`) ships nothing and says so.

Host-side edits: a **verbatim** file (skills, commands, agents, hooks, keybindings, the remapped JSON/TOML kinds, the global ignore) whose bytes differ from what the mirror last wrote while the laptop still sends the same bytes is host-edited — kept and reported as `host_edited` on this and every later push, however unrelated the laptop's changes, until the laptop copy itself changes (laptop wins) or the host restores the mirrored bytes. The **merged** kinds (`CLAUDE.md`/`AGENTS.md`, `settings.json`, codex `config.toml` and `hooks.json`, the gitconfig block) are co-owned with the host's own writers and are *not* host-edit protected: an edit to the user portion of the host's `CLAUDE.md` or to `settings.json` on the box is re-merged laptop over host on the next push. Edit those on the laptop. Pruning removes only verbatim files the mirror itself put under a managed root, still holding the mirror's bytes, that the laptop no longer ships (and the directories that empties); a stamped file the host edited is its own from then on; a merged file simply stops being tracked; a dropped gitconfig loses only its marker block. A host mirrored by another laptop refuses (`other_device`) until `cast hosts sync --take-over`; a host without a `user_id` refuses (`unprovisioned`) and the laptop logs the provisioning hint once.

```sh
cast hosts sync --dry-run          # what would ship: files, kinds, skipped, scrubbed, git identity
cast hosts sync                    # every reachable host (never wakes one)
cast hosts sync i-084309c56a91e15ff --take-over
cast config cloud_mirror_enabled false
cast config cloud_mirror_exclude ".claude/skills/private-*/**,.codex/prompts/**"
cast config cloud_mirror_include ".dotfiles/skills"      # the denylist still wins
```

`cast hosts ls` prints a `config mirror` line per host. Project-level untracked agent files (`CLAUDE.local.md`, `.claude/settings.local.json`, an untracked skill beside a tracked one, `AGENTS.md`, `.codex/config.toml`, `.agents/skills`, `.grok`) ride the manifest copy path at file granularity into every worktree, local and cloud; settings and codex config get the same scrub on the way, and one that cannot be parsed is left out with a warning in the spawn's progress. A staging set of more than eight files ships as one bundle to `cast cloud mirror-apply --stdin --into`, and a host whose `cast` predates the command (or has none on PATH) falls back to the per-file copy.
