# Workspace Backends

`cast workspace` can run a workspace on different substrates via pluggable
**backends**. Pick one with the `backend` field in `.codecast/workspace.toml`
or the `--backend` CLI flag. Default is `local`.

| Backend | Substrate | When to use | Cost |
|---|---|---|---|
| `local` | git worktree on this machine | Default. Fast, free, full local power. | free |
| `e2b` | E2B Firecracker microVM (Linux) | Ephemeral isolated runs; parallel agents; CI-like work. | ~$0.07/CPU-hour, per-second |
| `mac` | Scaleway Apple Silicon Mac (tart VM) | Persistent macOS dev env; real macOS Chrome for claude-in-chrome; Xcode/iOS. | M1-M ~€0.11/h, **24h min lease (~€2.64)** |

All backends satisfy the same contract — `acquire / release / exec / readFile
/ writeFile / validate / list` — so the rest of codecast treats them
identically. They differ only in where the workspace physically lives.

## Choosing a backend

```toml
# .codecast/workspace.toml
backend = "local"   # or "e2b" or "mac"
```

or per-invocation:

```bash
cast workspace acquire feat-x --backend e2b
```

## local (default)

Git worktree under `.codecast/worktrees/<name>` on your machine. Everything
runs on your hardware. This is what you get with no configuration. See the
main workspace docs for detection, manifest, hooks, and the warm pool.

## e2b — ephemeral Linux sandboxes

E2B (e2b.dev) gives each workspace a Firecracker microVM in the cloud.
Strong isolation, ~150ms boot, destroyed on release.

**Setup:**

```bash
# 1. Sign up at https://e2b.dev and create an API key
export E2B_API_KEY="e2b_..."

# 2. Install the SDK (soft dependency — only needed for the e2b backend)
bun add e2b   # or: npm install e2b

# 3. Acquire
cast workspace acquire feat-x --backend e2b
```

**How it works:**
- `acquire` creates a sandbox, clones your repo from its `origin` remote (or
  uploads a tarball if there's no remote), and runs your manifest's
  install/generate/migrate commands inside the sandbox.
- `exec` runs commands inside the sandbox over E2B's command API.
- `readFile`/`writeFile` use E2B's filesystem API.
- `release` kills the sandbox (and stops billing).

**Limits:** 1-hour max session by default (extendable via the SDK while in
use). Linux only — no macOS tooling. Browser is headless Chromium in the
Desktop Sandbox template.

## mac — persistent macOS dev environments

Scaleway Apple Silicon Mac minis, billed hourly (no AWS-style 24h minimum).
The key reason to choose this over `e2b`: **claude-in-chrome connects to a
real macOS Chrome, not headless Linux Chromium.** Same rendering pipeline,
fonts, and extension surface you have locally. Also the only way to run
Xcode / iOS Simulator / codesigning in the cloud.

**Architecture:** one long-lived Scaleway Mac per user, many workspaces per
host (each a [tart](https://github.com/cirruslabs/tart) VM). See
[`mac-backend.md`](./mac-backend.md) for the full design.

**Setup:**

```bash
# 1. In the Scaleway console, enable Apple Silicon and create an API key:
#    https://console.scaleway.com/iam/api-keys
export SCALEWAY_API_TOKEN="..."
export SCALEWAY_PROJECT_ID="..."   # console.scaleway.com/project/settings

# 2. Acquire — first run provisions a host (~10 min); later runs reuse it (~30s)
cast workspace acquire feat-x --backend mac
```

**Cost reality:** macOS cloud hosts have a **24-hour minimum lease** (Apple
licensing — true on AWS, Scaleway, MacStadium alike; not avoidable). M1-M ≈
€0.11/h → **~€2.64 minimum** committed per host, even if released immediately.
So the discipline is: provision once, run many workspaces on it through the
day, let it auto-destroy after the committed window. Don't spin a host up for a
30-second task.

## Writing a custom backend

Implement the `SandboxBackend` interface (in
`src/workspace/backends/types.ts`) and register it:

```ts
import { defaultRegistry } from "@codecast/cli/workspace";
import type { SandboxBackend } from "@codecast/cli/workspace";

const MyBackend: SandboxBackend = {
  name: "my-backend",
  async acquire(repoRoot, name, opts) { /* ... */ },
  async release(repoRoot, name) { /* ... */ },
  async exec(repoRoot, name, command, opts) { /* ... */ },
  async readFile(repoRoot, name, relativePath) { /* ... */ },
  async writeFile(repoRoot, name, relativePath, content) { /* ... */ },
  async heal(repoRoot, name) { /* ... */ },
  async validate(repoRoot, name) { /* ... */ },
  async list(repoRoot) { /* ... */ },
};

defaultRegistry.register(MyBackend);
```

Then run the parity suite against it:

```bash
CODECAST_TEST_BACKENDS=local,my-backend bun test src/workspace/backends/parity.test.ts
```

The parity suite runs the same cross-backend contract scenarios against every
listed backend — no test duplication.

## Testing backends

```bash
# Local only (default, always works, no credentials)
bun test src/workspace/backends/parity.test.ts

# Include cloud backends (requires their credentials)
E2B_API_KEY=... CODECAST_TEST_BACKENDS=local,e2b bun test src/workspace/backends/parity.test.ts
SCALEWAY_API_TOKEN=... SCALEWAY_PROJECT_ID=... CODECAST_TEST_BACKENDS=local,mac bun test src/workspace/backends/parity.test.ts
```
