# Clayground

A public multiplayer playground. Describe an app and Clay, the builder, makes
it in about a minute. Share the link: anyone who opens it can change the app by
chatting, and everyone sees each change go live within seconds. Every change
is a version on a timeline you can scrub, restore or fork into a new app with
its own room and link. No signup: each visitor gets an animal face and a name.

Live at https://clayground.almostcandid.workers.dev

`SPEC.md` says what the product does and is the source of truth for behavior.
`DESIGN.md` says how it looks, moves and talks.

## Run it locally

```bash
cd packages/playground
npx convex dev            # pushes convex/ to the dev deployment named in .env.local, and watches
bun run dev               # the shell on http://localhost:5317
```

The dev deployment needs `ANTHROPIC_API_KEY` (`npx convex env set ANTHROPIC_API_KEY ...`).
After changing anything under `runtime/`, run `bun run build:sdk`: the
deployment serves the bundled SDK from `convex/lib/sdk.generated.ts`.

Checks:

```bash
cast check playground     # one typecheck for the shell, convex/, runtime/, scripts/ and worker/
bun test <file>           # unit tests sit next to the code they cover
bun scripts/e2e.ts        # two visitors, real builds, end to end against dev
PLAYGROUND_CONVEX_URL=https://giant-clam-714.convex.cloud bun scripts/e2e.ts   # the same against prod
```

`scripts/verify-*.ts` exercise one layer each (builder, runtime, SDK,
timeline) against the dev deployment, and `scripts/builder-evals.ts` grades
real builds (`notes/builder-evals.md`).

## Deploy

```bash
cd packages/playground
bun run deploy
```

`scripts/deploy.ts` checks the SDK bundle is fresh, deploys `convex/` to the
production deployment of the `codecast-playground` Convex project
(`giant-clam-714`), builds the shell against it (`.env.production`), and
uploads it to the `clayground` Cloudflare Worker (`wrangler.jsonc`). Convex
goes first so the public shell never calls functions prod lacks.

This package is its own Convex project. `packages/convex/deploy.sh` and the
codecast prod deployment have nothing to do with it.

Production environment (set once, `npx convex env set --prod NAME`):

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Clay's builds and triage |
| `PLAYGROUND_SHELL_URL` | The public shell origin, used in link previews |
| `PLAYGROUND_BUILDS_OFF` | `1` stops every build (the kill switch) |

## How it fits together

```
browser ── shell (Cloudflare Worker, static) ──── WebSocket ──── Convex: giant-clam-714
   │                                                              ├─ apps, versions, room, presence
   └─ <iframe> app ── /run/<slug>/v/<n>/ on .convex.site ─────────┤  (HTTP actions, sandboxed)
                      SDK over WebSocket ──────────────────────────┘
```

**Shell** (`src/`). React, built by Vite. `App.tsx` routes `/` (home and
gallery), `/<slug>` (the clean app link: the app full-bleed plus a small
capsule), `?room` (the room overlay: chat, build cards, timeline) and
`/<slug>/v/<n>` (a past version). `surfaces/` holds one file per surface,
`ui/` the shared pieces, `lib/` the plumbing: visitor identity and its proof of
work (`identity.tsx`, `mint.ts`), routing, the Convex client.

**Backend** (`convex/`). Apps, versions, messages, presence and visitors, one
module each. `versions.ts` is the only writer of versions: they are immutable,
numbered per app, and restoring or forking appends a new one. `limits.ts` and
`lib/rateLimit.ts` hold rate limits and daily budgets, `reports.ts` the report
flag, `crons.ts` the cleanup.

**Builder** (`convex/builder/`). `triage.ts` decides whether an Auto message
asks for a change (Haiku). `queue.ts` runs one build at a time per app, each
from the live version. `run.ts` and `agent.ts` let Clay edit a draft of the
files with tools (`@platform/agent`, Sonnet) while the build card narrates,
then `draft.ts` validates, transpiles (`lib/transpile.ts`) and commits it as
the new live version. Prompts are in `prompts.ts`.

**Runtime** (`convex/http.ts`, `convex/runtime.ts`, `runtime/`). Each version
is static files served from the deployment's `.convex.site` origin under a
sandbox CSP without `allow-same-origin`, so an app cannot reach the shell or
other apps. Apps import the SDK (`runtime/sdk.ts`, served at `/run/sdk`):
shared collections and values, per-visitor values and presence, over its own
WebSocket with the credentials the shell hands it (`runtime/protocol.ts`).
The SDK also carries the point-and-talk picker.

**Hosting** (`worker/index.ts`, `wrangler.jsonc`). Static assets with SPA
fallback, so every `/<slug>` path is the shell. A link unfurler asking for an
app link gets that app's preview from `/og/<slug>` on the deployment instead.
