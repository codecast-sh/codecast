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

## Server-side wake (deployment and live proof pending)

The founder approved a dedicated server-side AWS identity. The backend now implements allowlisted wake requests and dispatches due triggers bound to those cloud conversations. `cloudWake` records a lease, bounded retries and the AWS request ID on the existing device row. An EC2 response means the instance is starting; a subsequent device heartbeat is required before the request is considered answered.

For configured owner/device pairs, laptop wake responses and daemon trigger claims are suppressed. Non-cloud jobs keep the existing daemon scheduler. Removing the allowlist restores the old laptop-mediated behavior; no local daemon reload is required. New `--spawn` triggers still use the existing daemon path: this server dispatcher is for triggers bound to existing cloud sessions.

AWS request signing and the queue have focused tests. The dedicated key passed real AWS DryRun authorization for the approved instance and was denied for another existing instance. **A stopped-host trigger run with all laptop mediators absent is not yet verified.** That proof requires the coordinated backend/config deployment; the earlier tr-500 evidence remains laptop-mediated only. See `infra/aws-cloud-waker/README.md` for rollout and rollback.

## Deferred storage optimization

Writable shared package symlinks were tested and rejected: one workspace's package mutation appeared in a sibling. Reflinks were unavailable on the host's ext4 filesystem. An OverlayFS proof isolated writes using a read-only lower layer and separate upper layers, but a production implementation needs per-workspace mounts, cleanup and cache-version lifecycle. That optimization was deliberately not built. Private dependencies and sufficient disk space are the baseline.
