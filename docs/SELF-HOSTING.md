# Self-Hosting Codecast

This guide covers running your own Codecast instance. The hosted version at [codecast.sh](https://codecast.sh) handles all of this for you.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A [Convex](https://www.convex.dev) deployment (self-hosted or cloud)
- A hosting platform for the web app (Railway, Vercel, any Node.js host)
- S3-compatible storage for CLI binary distribution (optional, for distributing the CLI)

## 1. Convex Backend

Codecast uses Convex for its real-time database, authentication, and serverless functions.

### Option A: Convex Cloud

1. Create a project at [dashboard.convex.dev](https://dashboard.convex.dev)
2. Note your deployment URL (e.g., `https://your-project.convex.cloud`)

### Option B: Self-Hosted Convex

1. Follow the [Convex self-hosting guide](https://docs.convex.dev/self-hosting)
2. Deploy Convex to your infrastructure (Railway, Docker, etc.)
3. Note your deployment URL and admin key

### Deploy Functions

```bash
cd packages/convex
cp .env.example .env.local
# Edit .env.local with your Convex URL and admin key
npx convex deploy
```

### Required Environment Variables

```bash
# packages/convex/.env.local
CONVEX_SELF_HOSTED_URL=https://your-convex-instance.example.com
CONVEX_SELF_HOSTED_ADMIN_KEY=your-admin-key

# Runtime secrets (set in Convex dashboard environment variables)
SITE_URL=https://your-codecast-domain.example.com
RESEND_API_KEY=re_...          # For auth emails
ANTHROPIC_API_KEY=sk-ant-...   # For AI features (summaries, insights)
```

## 2. Web Dashboard

The web app is a Vite + React SPA with an SSR server for bot/meta rendering.

```bash
cd packages/web
cp .env.example .env.local
# Edit .env.local with your Convex URL
bun install
bun run build
bun run start
```

The server listens on `PORT` (default 3000). Put it behind a reverse proxy with HTTPS.

### Optional: GitHub Integration

To enable PR comments and GitHub OAuth login:

1. Create a GitHub App at github.com/settings/apps
2. Set the callback URL to `https://your-domain/api/auth/callback/github`
3. Add the app credentials to your Convex environment variables:
   ```
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----...
   GITHUB_APP_WEBHOOK_SECRET=your-webhook-secret
   ```

### Optional: Analytics

Add Sentry and PostHog keys to `packages/web/.env.local` for error tracking and product analytics.

## 3. CLI Distribution

The CLI (`cast`) is distributed as pre-built binaries uploaded to S3-compatible storage.

### Build from source

```bash
cd packages/cli
bun install
bun run build
```

The built CLI is at `packages/cli/dist/index.js`. Run with `bun packages/cli/dist/index.js`.

### Distribute binaries

To distribute pre-built binaries (like the hosted version does):

1. Set up an S3-compatible bucket (Cloudflare R2, AWS S3, MinIO)
2. Configure deploy environment:
   ```bash
   export R2_ENDPOINT=https://your-account.r2.cloudflarestorage.com
   export AWS_ACCESS_KEY_ID=your-key
   export AWS_SECRET_ACCESS_KEY=your-secret
   ```
3. Run `./scripts/deploy.sh` to build and upload

## 4. Desktop App (Optional)

```bash
cd packages/electron
bun install
bun run build
```

For distribution, you'll need your own Apple Developer account for macOS code signing and notarization. Set `APPLE_TEAM_ID`, `APPLE_ID`, and `APPLE_PASSWORD` environment variables.

## 5. Mobile App (Optional)

```bash
cd packages/mobile
bun install
cp .env.example .env.local
# Edit with your Convex URL
npx expo start
```

For App Store distribution, configure `eas.json` with your own Apple Developer credentials.

## 6. Admin Access

After deploying, set your user's `role` field to `"admin"` in the Convex dashboard to enable admin features (daemon logs, user management, system commands).

## Architecture Diagram

```
                    ┌──────────────┐
                    │  Web App     │
                    │  (Railway)   │
                    └──────┬───────┘
                           │
┌──────────┐       ┌──────┴───────┐       ┌──────────┐
│  CLI     │──────▶│   Convex     │◀──────│  Mobile  │
│  Daemon  │       │  (Database)  │       │  App     │
└──────────┘       └──────┬───────┘       └──────────┘
                           │
                    ┌──────┴───────┐
                    │  Desktop     │
                    │  App         │
                    └──────────────┘
```

The CLI daemon is the data ingestion layer -- it watches local agent session files and syncs them to Convex. All other clients (web, desktop, mobile) connect to Convex for real-time data.
