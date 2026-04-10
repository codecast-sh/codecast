# Getting Started with Codecast Development

## What You're Setting Up

A CLI daemon watches AI coding sessions (Claude Code, Codex, Cursor, Gemini) and syncs them to a Convex backend. A React dashboard displays everything in real time.

```
~/.claude/projects/**/*.jsonl ──┐
~/.codex/history/**/*.jsonl ────┤
~/.cursor/ ─────────────────────┼──▶ CLI Daemon ──▶ Convex Backend ──▶ Web Dashboard
~/.gemini/ ─────────────────────┘   (packages/cli)  (packages/convex)  (packages/web)
```

| Package | What it does |
|---------|-------------|
| `packages/cli` | CLI daemon — watches sessions, syncs to Convex |
| `packages/convex` | Backend — schema, queries, mutations, auth |
| `packages/web` | React + Vite dashboard |
| `packages/shared` | Shared crypto utilities |
| `packages/electron` | Desktop app (Electron wrapper) |
| `packages/mobile` | iOS app (Expo / React Native) |

---

## 1. Prerequisites

```bash
# Bun (package manager + runtime)
curl -fsSL https://bun.sh/install | bash

# Node.js 20+ (required by Convex CLI)
brew install node
```

## 2. Clone and Install

```bash
git clone git@github.com:ashot/codecast.git
cd codecast
bun install
```

## 3. Create Environment Files

Run these commands from the repo root to create all env files:

### Root `.env.local`

```bash
cat > .env.local << 'EOF'
CONVEX_URL=https://convex.codecast.sh
NEXT_PUBLIC_CONVEX_URL=https://convex.codecast.sh
EOF
```

### `packages/convex/.env.local`

```bash
cat > packages/convex/.env.local << 'EOF'
CONVEX_SELF_HOSTED_URL=https://convex.codecast.sh
CONVEX_SELF_HOSTED_ADMIN_KEY=<get-from-team-lead>
CONVEX_URL=https://convex.codecast.sh
CONVEX_SITE_URL=https://convex.codecast.sh
EOF
```

### `packages/web/.env.local`

```bash
cat > packages/web/.env.local << 'EOF'
VITE_CONVEX_URL=https://convex.codecast.sh
VITE_GITHUB_APP_SLUG=codecast-sh
VITE_SENTRY_DSN=<get-from-team-lead>
VITE_POSTHOG_KEY=<get-from-team-lead>
VITE_POSTHOG_HOST=https://us.i.posthog.com
PORT=3000
EOF
```

### `packages/cli/.env.local`

```bash
cat > packages/cli/.env.local << 'EOF'
CONVEX_URL=https://convex.codecast.sh
CODE_CHAT_SYNC_WEB_URL=https://codecast.sh
EOF
```

### Optional: `packages/mobile/.env.local`

Only if working on the iOS app:

```bash
cat > packages/mobile/.env.local << 'EOF'
EXPO_PUBLIC_CONVEX_URL=https://convex.codecast.sh
EXPO_PUBLIC_POSTHOG_KEY=<get-from-team-lead>
EXPO_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
EOF
```

### Optional: `packages/electron/.env.local`

Only if working on the desktop app:

```bash
cat > packages/electron/.env.local << 'EOF'
CODECAST_URL=http://local.codecast.sh
EOF
```

## 4. Set Up Local Domains

```bash
sudo ./setup-hosts.sh
```

This adds `local.codecast.sh` (and `local.1.codecast.sh`, `local.2.codecast.sh`) to `/etc/hosts` and installs an nginx proxy. Skip this if you're fine using `http://localhost:3200`.

## 5. Start Everything

```bash
./dev.sh
```

This starts Convex + Vite with a watchdog that auto-restarts crashed processes. Open **http://local.codecast.sh** (or `http://localhost:3200`).

`Ctrl+C` to stop. Just run `./dev.sh` again to restart — it self-cleans.

### Multi-instance

```bash
./dev.sh 0    # port 3200 → local.codecast.sh
./dev.sh 1    # port 3201 → local.1.codecast.sh
./dev.sh 2    # port 3202 → local.2.codecast.sh
```

### Running packages separately

```bash
cd packages/convex && bun run dev    # Convex backend (hot-reloads functions)
cd packages/web && bun run dev       # Vite dev server (HMR)
cd packages/cli && bun run dev       # CLI daemon (optional)
```

## 6. Convex Application Env Vars

The `.env.local` file from step 3 handles deployment credentials. The application env vars below are already set on the production Convex deployment. You only need to run these if you're setting up a new instance — for the shared dev environment, these are already configured:

```bash
cd packages/convex
npx convex env set SITE_URL "https://codecast.sh"
npx convex env set RESEND_API_KEY "<get-from-team-lead>"
npx convex env set ANTHROPIC_API_KEY "<get-from-team-lead>"
npx convex env set AUTH_GITHUB_ID "<get-from-team-lead>"
npx convex env set AUTH_GITHUB_SECRET "<get-from-team-lead>"
npx convex env set AUTH_APPLE_ID "sh.codecast.web"
npx convex env set AUTH_APPLE_SECRET "<get-from-team-lead>"
npx convex env set GITHUB_APP_ID "<get-from-team-lead>"
npx convex env set GITHUB_APP_PRIVATE_KEY "<get-from-team-lead>"
npx convex env set GITHUB_APP_WEBHOOK_SECRET "<get-from-team-lead>"
npx convex env set GITHUB_WEBHOOK_SECRET "<get-from-team-lead>"
```

The Convex dashboard for the self-hosted instance is at:
`https://convex-dashboard-production-bc8d.up.railway.app/`

(`npx convex dashboard` does not work with self-hosted Convex.)

## 7. CLI Setup

Build and install the CLI if you need `cast` commands:

```bash
cd packages/cli
bun run build:binary               # produces ./codecast
cp codecast ~/.local/bin/codecast
ln -sf ~/.local/bin/codecast ~/.local/bin/cast

cast setup                          # configure server URLs
cast auth                           # authenticate via browser
cast start                          # start the daemon
```

The CLI config lives at `~/.codecast/config.json`:

```json
{
  "web_url": "https://codecast.sh",
  "convex_url": "https://convex.codecast.sh",
  "auth_token": "set-by-cast-auth"
}
```

## 8. Testing

### E2E tests

Add test credentials to `packages/web/.env.local`:

```bash
TEST_USER_EMAIL=<get-from-team-lead>
TEST_USER_PASSWORD=<get-from-team-lead>
```

Then:

```bash
./scripts/run-e2e-suite.sh
```

### Convex test scripts

Some test scripts hit the Convex API directly. Get a token from `cast auth` or the Convex dashboard:

```bash
CONVEX_API_TOKEN=your-token bun packages/convex/test-pending-messages.ts
```

### Unit tests

```bash
cd packages/web && bun test
cd packages/cli && bun test
bun run typecheck                   # all packages
```

---

## Runtime Flags

These aren't in `.env` files — set them in your shell when needed:

```bash
# Debugging
DEBUG=1 cast start                  # verbose daemon logs
DEBUG_CLI=1 cast status             # verbose CLI command output
ASK_DEBUG=1 cast ask "query"        # debug AI search

# Pause sync
CODECAST_PAUSED=1 cast start        # start daemon but don't sync
# CODE_CHAT_SYNC_PAUSED=1           # legacy name, same effect

# Override working directory
CODECAST_CWD=/path/to/project cast start

# Bind session to task/plan
CODECAST_TASK_ID=ct-xxx cast start
CODECAST_PLAN_ID=pl-xxx cast start

# Disable colored output
NO_COLOR=1 cast status

# Parallel agents (used by init.sh for port allocation)
AGENT_RESOURCE_INDEX=1 ./init.sh    # Web 3100, Convex 3101
```

These are set automatically by coding agents (don't set manually):

```bash
CLAUDE_CODE_SESSION_ID=...          # set by Claude Code
CODEX_SESSION_ID=...                # set by Codex CLI
CODECAST_RESTART=1                  # set when daemon auto-restarts
```

The daemon also reads these OS-level vars (you don't set them):

```bash
HOME                                # ~/.codecast, ~/.claude, etc.
PATH                                # enriched with /opt/homebrew/bin for spawned processes
APPDATA                             # Windows: Cursor config path
XPC_SERVICE_NAME                    # macOS: detects if running as launchd service
TMUX / TMUX_PANE                    # tmux session/pane detection
```

---

## CLI Binary Distribution

Only needed if distributing pre-built CLI binaries (not for local dev):

Create `packages/cli/.env.deploy`:

```bash
AWS_ACCESS_KEY_ID=<s3-access-key>
AWS_SECRET_ACCESS_KEY=<s3-secret-key>
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
```

Then `cd packages/cli && ./scripts/deploy.sh`.

---

## Convex Auto-Set Vars

These appear in code but are set by the Convex runtime or Railway infrastructure, not by you:

```bash
CONVEX_SITE_URL        # auth.config.ts — auth provider domain, set by Convex
CONVEX_CLOUD_ORIGIN    # Railway env var on convex-backend service
CONVEX_CLOUD_URL       # alias for CONVEX_CLOUD_ORIGIN
```

---

## Scripts

| Script | What it does |
|--------|-------------|
| `./dev.sh` | Start Convex + Vite with watchdog |
| `./dev.sh N` | Multi-instance (port 3200+N) |
| `./init.sh` | First-time setup (install, env files, smoke test) |
| `sudo ./setup-hosts.sh` | Add local domains to `/etc/hosts`, install nginx |
| `./check.sh` | Health check |
| `./scripts/deploy.sh` | Bump version, build, and deploy CLI binaries |
| `./scripts/deploy-all.sh` | Full deployment (Convex + web + CLI) |
| `./scripts/backup-convex.sh` | Backup Convex data (set `BACKUP_DIR`, `RETENTION_DAYS` to override defaults) |
| `./scripts/run-e2e-suite.sh` | Run E2E test suite |

## Troubleshooting

**`dev.sh` says hostname not in `/etc/hosts`** — Run `sudo ./setup-hosts.sh`.

**Convex functions not updating** — Make sure `convex dev` is running. Restart `./dev.sh`.

**Port already in use** — `dev.sh` self-cleans, just run it again. Or: `lsof -ti :3200 | xargs kill`.

**CLI can't connect** — Check `~/.codecast/config.json`, try `curl https://convex.codecast.sh`, re-auth with `cast auth`.

**Auth callback fails** — `SITE_URL` on the Convex deployment must match your web app URL exactly (with protocol, no trailing slash).

**`npx convex dashboard` doesn't work** — Use `https://convex-dashboard-production-bc8d.up.railway.app/` directly. Self-hosted Convex doesn't support the CLI dashboard command.
