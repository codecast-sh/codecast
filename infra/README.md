# Convex Self-Hosted Infrastructure

## Architecture

```
Railway Project: codecast-convex
  caddy-proxy       -- Caddy reverse proxy (single public HTTPS endpoint)
  convex-backend    -- Convex backend engine (ports 3210 + 3211 internal)
  convex-dashboard  -- Admin dashboard (port 6791, internal)
  postgres          -- PostgreSQL database
```

Caddy routes incoming requests:
- `/.well-known/*`, `/api/*`, `/cli/*` -> port 3211 (HTTP actions)
- Everything else -> port 3210 (backend: queries, mutations, subscriptions)

## Setup

### 1. Deploy via Railway template

Click: https://railway.com/deploy/convex-w-reverse-proxy

This creates a new Railway project with all four services.

### 2. Replace the reverse proxy

The template's default proxy only routes `/.well-known/*` and `/api/auth/*` to HTTP actions.
We need `/api/*` and `/cli/*` routed too.

Option A: Update the Caddy service to use our custom image:
- Build and push `infra/convex-proxy/Dockerfile` to a container registry
- Update the Railway service to use this image

Option B: Configure the Railway Caddy service environment:
- If the proxy image supports env var configuration, add our paths

### 3. Get the admin key

After first deployment, check the backend deploy logs for the admin key line.
It looks like: `codecast|<64-character-hex-key>`

Set this as `CONVEX_SELF_HOSTED_ADMIN_KEY` on the backend service, then restart.

### 4. Add custom domain

Add `convex.codecast.sh` as a custom domain on the Caddy proxy service.
Create a CNAME DNS record: `convex.codecast.sh -> <railway-assigned-domain>`

### 5. Set backend environment variables

On the Convex backend service, set:
```
CONVEX_CLOUD_ORIGIN=https://convex.codecast.sh
CONVEX_SITE_ORIGIN=https://convex.codecast.sh
SITE_URL=https://codecast.sh
```

Plus all app-specific env vars (AUTH_GITHUB_ID, RESEND_API_KEY, etc.)
via `npx convex env set` or the dashboard.

### 6. Run migration

```bash
export CONVEX_SELF_HOSTED_URL=https://convex.codecast.sh
export CONVEX_SELF_HOSTED_ADMIN_KEY=<from step 3>
./scripts/migrate-to-self-hosted.sh
```

## Local development

Set in `packages/convex/.env.local`:
```
CONVEX_SELF_HOSTED_URL=https://convex.codecast.sh
CONVEX_SELF_HOSTED_ADMIN_KEY=<your admin key>
```

Then `bun run dev` in packages/convex works as before.

## Custom Caddy proxy

Our Caddyfile at `infra/convex-proxy/Caddyfile` routes:
- `/.well-known/*` -> HTTP actions (auth discovery)
- `/api/*` -> HTTP actions (auth callbacks, GitHub App, webhooks)
- `/cli/*` -> HTTP actions (CLI exchange-token)
- Everything else -> backend (Convex client protocol)
