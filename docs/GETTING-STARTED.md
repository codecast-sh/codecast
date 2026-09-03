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

### Optional: desktop app against your local web

The desktop app reads no `.env` file. Pass the origin on the command line; `bun run dev` in `packages/electron` already does (`CODECAST_URL=https://local.codecast.sh electron .`). The origin must be https: the http one redirects and lands on a different localStorage origin.

A from-source run (`electron .`) also opens a Chrome DevTools Protocol port on `127.0.0.1:9333` so `cast app` and the perf harness can drive it. Set `CODECAST_CDP_PORT` to move it, or to open one on a packaged build.

## 4. Set Up Local Domains

```bash
sudo ./setup-hosts.sh
```

This adds `local.codecast.sh` (and `local.1.codecast.sh`, `local.2.codecast.sh`) to `/etc/hosts` and installs an nginx proxy. Skip this if you're fine using `http://localhost:3200`.

## 5. Start Everything

```bash
./dev.sh
```

This starts Convex + Vite with a watchdog that auto-restarts crashed processes. Open **https://local.codecast.sh** (http redirects to https) or `http://localhost:3200`.

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

### Unit and integration tests

Every package runs `bun test`. `bun run test` at the root fans out through turbo. CI runs the web, convex, and cli suites plus the cli messaging e2e (real tmux) on every push to `main`.

### End-to-end proof

`cast doctor` proves the sync loop live: transcript to server, server to daemon to tmux inject, echo back. Exit code 0 means the whole loop works.

### Driving the app itself: `cast app`

`cast app` drives the running web or desktop app the way a user does, on top of `cast browser`. `cast browser` knows pages; `cast app` knows codecast: which surface is which, what "signed in" and "settled" mean, which build is loaded, and how to become a known account for a run. Every verb attaches to the page over the Chrome DevTools Protocol and reads the app's own handles (`window.__CODECAST_BUILD`, `__syncActivity`, `__syncReplication`, `__navLog`, and the dev-only `__inboxStore`), so nothing scrapes the DOM for state.

```bash
cast app doctor                     # origin, build, account, daemon owner, sync role, settled; exit 1 if not drivable
cast app surfaces                   # the surfaces goto accepts and sweep walks
cast app goto tasks                 # a surface by name; confirms where the app landed
cast app goto jx7abcd               # a conversation by short id
cast app wait-settle                # catch-up quiet, outbox empty
cast app sweep --json               # every surface: rendered, no crash, no errors, no redirect
cast app as-user demo@example.com   # sign the page in as a named account (--restore puts yours back)
cast app shot                       # screenshot into the conversation
cast app --desktop doctor           # the same against the desktop app
```

The loop is doctor, goto, wait-settle, then prove with `cast browser` (snapshot, get text, shot) or `eval`.

The target is this session's tab, in whichever browser `cast browser` would use: your own Chrome through the extension when it is paired (`--real`), the agent browser otherwise (`--clone`). The origin is local dev when vite answers on port 3200 and production otherwise (`--origin <url>` or `CAST_APP_ORIGIN` overrides). `--desktop` drives the desktop app over its debugging port instead: a from-source run opens `127.0.0.1:9333`, a packaged build only with `CODECAST_CDP_PORT` set. Any Electron app can own that port (the mail app takes 9333 when it starts first), so doctor refuses a port whose pages are not codecast; run codecast with `CODECAST_CDP_PORT=<free port>` and pass the same variable to `cast app`.

`goto` and `sweep` navigate in-app (pushState, the way a click routes) so surfaces switch in milliseconds and the store stays warm. The tab shell re-asserts its own URL when the destination is outside it (the settings pages, for one), so a bounced navigation falls back to a full document load; `--reload` forces that for every step. On local dev a full load is a vite transform pass and can take 30 seconds or more.

`as-user` mints a real token pair through `packages/convex/run.sh verification:mintSession` (admin key, so only from the codecast checkout), parks every app window on a blank page, swaps the pair into localStorage and reloads. Parking matters: any live document on the origin holds an auth client that rotates a fresh refresh token the moment it sees it, and the reloaded page then boots signed out. The identity that was there is saved on the page; `as-user --restore` puts it back. It never touches your own Chrome (`--clone` or `--desktop` only), and on the shared agent browser it refuses when other sessions' tabs are on the origin unless you pass `--force`. The user must own this machine's daemon for daemon-backed surfaces (terminal, vault, device commands) to read as online; doctor says when they do not.

The surface list lives in `@codecast/shared/contracts/appSurfaces.ts`. A test in `routes.manifest.test.ts` fails when a param-free signed-in route is missing from it, or when it names a route the router no longer serves.

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

### Cut a release from CI (no local certificate)

The macOS binaries are signed with the Developer ID certificate
(`Developer ID Application: Ashot Petrosian (WRG9THCK9Q)`). The certificate and
its passphrase live in two repo secrets, `MACOS_SIGN_CERT_P12` and
`MACOS_SIGN_CERT_PASSPHRASE`, so releases do not need the certificate in a
personal keychain. To cut a release:

```bash
gh workflow run cut-cli-release.yml -R codecast-sh/codecast
```

The workflow builds all five binaries on a macOS runner, signs the two darwin
binaries, uploads the staging objects to R2, and dispatches "Finalize
pre-uploaded CLI release". Finalize validates everything, publishes the
immutable R2 objects and `latest.json`, commits the version bump, tags, and
creates the GitHub release. Pass `-f dry_run=true` to build and sign without
publishing anything.

The CI path does not publish the npm package or the Homebrew tap. Those are
non-fatal mirrors that `deploy.sh` publishes from a laptop. To rotate the
certificate: export a fresh `.p12` from Keychain Access and replace both
secrets.

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

## Troubleshooting

**`dev.sh` says hostname not in `/etc/hosts`** — Run `sudo ./setup-hosts.sh`.

**Convex functions not updating** — Make sure `convex dev` is running. Restart `./dev.sh`.

**Port already in use** — `dev.sh` self-cleans, just run it again. Or: `lsof -ti :3200 | xargs kill`.

**CLI can't connect** — Check `~/.codecast/config.json`, try `curl https://convex.codecast.sh`, re-auth with `cast auth`.

**Auth callback fails** — `SITE_URL` on the Convex deployment must match your web app URL exactly (with protocol, no trailing slash).

**`npx convex dashboard` doesn't work** — Use `https://convex-dashboard-production-bc8d.up.railway.app/` directly. Self-hosted Convex doesn't support the CLI dashboard command.
