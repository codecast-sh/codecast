# MacMiniBackend — Architecture (Phase D5)

This document specifies how `cast workspace acquire ... --backend mac` works against a Scaleway Apple Silicon Mac mini. It defines the substrate model, exec channel, file sync, credentials, and idle handling — the constraints D6 must satisfy.

## Why a Mac backend exists

Two reasons codecast users need this beyond what E2B offers:

1. **claude-in-chrome talks to real macOS Chrome**, not headless Chromium on Linux. Different rendering pipelines, fonts (San Francisco vs Inter substitution), extension surface, Safari WebKit fallbacks. For frontends that look correct locally on Mac but break in headless Linux Chromium, this preserves the substrate.
2. **Dev environment fidelity**. macOS-specific tooling (Xcode, iOS Simulator, AppleScript, codesigning) doesn't run on Linux. For a codecast user who develops native Mac/iOS code, the cloud workspace must be macOS for the work to mean anything.

## The substrate: one host, many workspaces

E2B's model is "one ephemeral VM per workspace, destroyed on release."

The Mac model is fundamentally different because of cost economics: even Scaleway's cheaper hourly billing (~€0.11/hr for M1 mini) means we want to amortize a host across many workspaces. **One Scaleway Mac per codecast user**, with multiple workspaces sharing the host:

```
                    ┌─ Scaleway Mac M1 (one host per user) ─┐
                    │                                        │
codecast user  ───→ │  workspace "feat-auth"  ──┐            │
                    │  workspace "fix-bug"    ──┼─ all       │
                    │  workspace "experiment" ──┘  on        │
                    │                              same Mac  │
                    └────────────────────────────────────────┘
```

This maps the Phase B warm-pool work onto the Mac model: the Scaleway Mac **is** the warm pool host. Workspaces are slots within it.

## Workspace isolation on a single Mac

Three reasonable approaches; ranked by isolation strength:

### Option A: tart VMs (recommended)

[tart](https://github.com/cirruslabs/tart) is an Apple-blessed CLI for creating Apple Silicon VMs using macOS Virtualization.framework. Each workspace gets its own VM image with its own filesystem, network namespace, and processes.

**Pros**: Strong isolation (real VM boundary), snapshotting, clean teardown via `tart delete`, well-maintained.
**Cons**: VM boot adds ~30s per workspace claim. Disk usage per VM (~10-30GB base + overlay).
**Verdict**: The right call for v1. Cost amortized across many workspaces per host, and the isolation matters for parallel agents.

### Option B: macOS user accounts

Each workspace = a system user account on the host (`workspace-feat-auth`, `workspace-fix-bug`). Shares the host kernel but isolates `$HOME`, processes (via launchd per-user sessions), and Chrome user-data-dir.

**Pros**: Lighter than VMs. No VM boot time. Easy to provision (`sysadminctl -addUser`).
**Cons**: Shared kernel — runaway processes affect all workspaces. macOS user creation is permissioned and slower than Linux user add. Cleanup is fiddly.
**Verdict**: Acceptable if users rarely run isolated/untrusted code. Worse isolation than tart but acceptable for many use cases.

### Option C: directory-only isolation

Each workspace = a subdirectory (`/Users/codecast/workspaces/feat-auth/`). No process/user/network isolation; just file separation.

**Pros**: Trivial provisioning. Zero overhead.
**Cons**: No real isolation. Two parallel agents can collide on ports/processes. Single bug in one workspace can corrupt all of them.
**Verdict**: Only suitable for trusted single-agent workflows. Not v1.

**Decision: Use Option A (tart VMs) as the default**, with B available as an opt-in for users who explicitly want lower overhead and trust their workloads.

## Exec channel: SSH

The codecast CLI runs locally; commands need to reach the remote Mac. Options:

1. **Plain SSH** to the host's public IPv6/IPv4 from Scaleway. Mac's IP is stable while the host exists.
2. **Tailscale** mesh for zero-config private network. Requires Tailscale auth on both sides.
3. **Scaleway bastion** for security-isolated networks.

**Decision: Plain SSH.** Scaleway gives the host a public IPv6 and (for some tiers) IPv4. We use SSH with a per-user keypair generated at first host provisioning, stored at `~/.codecast/scaleway/<host-id>/id_ed25519`. Tailscale can be a layered option later.

For exec into a tart VM specifically: SSH lands on the host, then `ssh -J host vm-internal-ip` or `tart ssh vm-name -- cmd`. The tart CLI handles the inner SSH transparently.

## File sync: rsync over SSH

`readFile` and `writeFile` need to move bytes to/from the workspace.

- Single file read/write: `scp` or `cat | ssh` (small overhead per operation, fine for occasional file ops).
- Large directory sync (initial git clone, post-setup): `rsync -avz` over SSH.

For SandboxBackend.readFile/writeFile (single file API), use `scp` directly. For bulk sync we'd add a separate helper (not in the interface yet, can extend later).

## Credentials and provisioning

**Per-user credentials needed:**
- `SCALEWAY_API_TOKEN` — used to provision/start/stop hosts via Scaleway API
- `SCALEWAY_PROJECT_ID` — Scaleway project the host lives in
- Generated per-host SSH keypair stored locally under `~/.codecast/scaleway/<host-id>/`
- Apple Silicon dedicated hosts must be enabled in the user's Scaleway console first (manual step — can't automate)

**Provisioning flow:**
1. User runs `cast workspace acquire feat-x --backend mac` for the first time.
2. CLI looks for an existing usable host in `~/.codecast/scaleway/hosts.json`.
3. If none: provision a new M1 host via Scaleway API (POST /apple-silicon/v1alpha1/zones/<zone>/servers). Wait for `ready` state (typically 8-15 min).
4. Generate SSH keypair, install via Scaleway's serial-console or first-boot script.
5. Install tart via Homebrew or pre-baked image.
6. Pull or build a base macOS-Sonoma tart image.
7. Cache base image + host metadata for future acquires.
8. For this acquire: create a fresh tart VM from base, start it, SSH in, git clone repo, run setup.

After the first acquire, subsequent ones reuse the host and skip 1-7. They take ~30s (tart VM clone + boot + setup) instead of ~10 minutes.

## Idle handling and cost discipline

**Reality check (verified against the live Scaleway API):** every macOS server
type carries `minimum_lease_duration = 86400s` — a **24-hour minimum billing
commitment**. This is an **Apple licensing requirement** (macOS EULA mandates a
24h minimum for cloud Mac rentals), identical across AWS EC2 Mac, Scaleway, and
MacStadium. It is **not** a provider-specific quirk, and there is no sub-24h
macOS option anywhere. (Scaleway's only 0s-minimum Apple Silicon type is
`M2-L-ASAHI`, which runs Asahi **Linux** — useless for our real-macOS goal.)

This changes the cost model fundamentally:

- Provisioning a host commits to ~24h of billing (M1-M ≈ €0.11/h → ~€2.64
  minimum) **even if released seconds later**. Stopping early does NOT refund
  the committed window.
- Therefore the discipline is NOT "stop quickly to save money" — it's
  **"provision deliberately, then amortize hard across the 24h window."** One
  host should serve many workspaces for a full day before teardown.

Concrete policy:

- Hosts in `~/.codecast/scaleway/hosts.json` carry `lastUsedAt`.
- `autoStopIdleHosts()` powers a host off after idle (default 30 min) to stop
  *additional* charges beyond the committed window and free the hardware — but
  understand the first 24h is already sunk.
- `autoDestroyOldHosts()` destroys hosts idle > 24h (after the committed window
  elapses, so destruction wastes nothing).
- Best practice for users: provision once at the start of a Mac-heavy work
  session, run all your workspaces on it that day, let it auto-destroy after.

## SandboxBackend method mapping

How the standard interface maps onto this substrate:

| SandboxBackend method | MacMiniBackend implementation |
|---|---|
| `acquire(repoRoot, name, opts)` | Ensure host exists (provision if needed). Create tart VM. SSH in. Git clone repoRoot's HEAD. Run setup commands. Return Workspace pointing at the VM. |
| `release(repoRoot, name)` | Stop the tart VM. Delete it. Update host's `lastUsedAt`. Host stays running for next claim (until idle-stop kicks in). |
| `exec(repoRoot, name, cmd, opts)` | SSH to host, then `tart ssh <vm> -- bash -lc "<cmd>"`. Pipe stdin if provided. Return stdout/stderr/exitCode. |
| `readFile(repoRoot, name, path)` | `scp host:<vm-mounted-path>/<path> -` or via `tart ssh ... cat <path>` |
| `writeFile(repoRoot, name, path, content)` | `cat | tart ssh ... tee <path>` or scp |
| `validate(repoRoot, name)` | Standard contract checks via SSH probes (worktree exists, deps installed, etc). |
| `list(repoRoot)` | Combine local state (which workspaces exist) + tart list of running VMs on the host. |

## What this looks like for the codecast user

```bash
# First time on this machine
$ export SCALEWAY_API_TOKEN=...
$ export SCALEWAY_PROJECT_ID=...
$ cast workspace acquire feat-auth --backend mac
provisioning a new Scaleway Mac M1 host (this takes ~10 min)...
host ready: mac-host-xyz
creating tart VM workspace-feat-auth...
git clone... bun install...
ready: feat-auth on mac-host-xyz
  ssh: tart ssh workspace-feat-auth (via mac-host-xyz)
  cost so far: €0.02

# Second workspace — much faster
$ cast workspace acquire fix-bug --backend mac
reusing host mac-host-xyz
creating tart VM workspace-fix-bug...
ready: fix-bug on mac-host-xyz (30s)

# Both running in parallel
$ cast workspace ls --backend mac
NAME       STATE  HOST              VM
feat-auth  ready  mac-host-xyz      workspace-feat-auth
fix-bug    ready  mac-host-xyz      workspace-fix-bug

# Idle for a while → host auto-stops
$ cast workspace acquire fix-bug --backend mac  # resume
resuming host mac-host-xyz... (~60s)
reattaching to workspace fix-bug

# Explicit cleanup
$ cast workspace destroy fix-bug --backend mac
stopped VM workspace-fix-bug
host mac-host-xyz still running (1 workspace remaining)
```

## Open questions for D6 implementation

1. **tart image source**: Bake our own `macos-sonoma-codecast` image and host on a CDN, or ship a script that bootstraps a vanilla Sonoma + Homebrew? First-acquire experience favors the former; maintenance burden favors the latter. **Lean: ship the bootstrap script, cache the resulting image on the user's host after first run.**
2. **VM image storage on host**: tart stores VMs under `~/.tart`. M1 minis have 256GB-1TB SSDs; we can fit ~20 lightweight VMs per host. Beyond that, we'd need eviction policy.
3. **claude-in-chrome installation**: The MCP server runs locally; the cloud Mac just runs Chrome. The MCP client needs to connect to the cloud Chrome via the CDP endpoint over SSH port-forwarding. We need a small helper that opens `ssh -L 9222:vm-ip:9222 host` when an agent wants to drive the cloud browser.

## Acceptance criteria for D6

1. `mac` backend appears in `cast workspace --backend` help text.
2. With `SCALEWAY_API_TOKEN` set to a fake value, unit tests pass against a mock Scaleway API client.
3. Without `SCALEWAY_API_TOKEN`, attempting `--backend mac` produces a clear error pointing to the setup docs.
4. SandboxBackend interface fully satisfied (parity tests with mocked API will pass).
5. Code structure matches the substrate model in this doc (tart-based, SSH exec, scp file sync).

## Acceptance criteria for D7 (live e2e)

1. Real Scaleway M1 host provisioned, tart VM created, SSH reachable.
2. Full `acquire → exec("uname -a") returns "Darwin ... arm64" → readFile/writeFile roundtrip → release` cycle.
3. claude-in-chrome can connect to the cloud Chrome (proves the substrate parity claim).
4. Total spend across the test does not exceed €0.50 (one M1 host-hour budget).
5. Host is stopped (not just VM destroyed) at end of test so billing pauses.
