# infra/

Configuration and code for what runs outside the app packages. Production Convex moved from Railway to one AWS host on 2026-09-15; [convex-host/README.md](convex-host/README.md) records the facts about that machine and is the place to start.

| Directory | What it is | Where it runs |
|---|---|---|
| [convex-host/](convex-host/README.md) | The Convex backend, its dashboard and the Caddy proxy for `convex.codecast.sh`: compose file, Caddyfile, `.env.example`, and the host runbook | The production host, `/srv/convex` |
| `convex-host/logtail/` | Streams the backend's function log to hourly gzip files, kept 14 days | The production host, `/srv/convex-logtail` |
| `host/postgres/` | Compose file for the production Postgres primary | The production host, `/srv/postgres` |
| `pg-replica/` | The image and entrypoint that Postgres container is built from (it began as a streaming standby and was promoted), plus `promote.sh` | Built by `host/postgres` |
| [host/pg-backup/](host/pg-backup/README.md) | systemd service and timer for the nightly `pg_dump` to R2 | The production host |
| `pg-backup/` | The image and script that backup runs | Built on the host as `codecast/pg-backup` |
| [aws-cloud-waker/](aws-cloud-waker/README.md) | IAM policy for the identity that may start one approved EC2 instance | AWS IAM |
| `artifact-edge/` | Cloudflare Worker: edge cache for published pages at `a.codecast.sh` | Cloudflare (`npx wrangler deploy`) |
| `replay-player/` | Cloudflare Worker: the replay player and frame renderer at `replay.codecast.sh` | Cloudflare (`bun run deploy`) |
| `call-face-worker/` | LiveKit agent worker that seats an agent's face in a call | Its own container (Dockerfile, `railway.json`) |
| `convex-proxy/` | The Caddy proxy for a Convex deployment on Railway. Production no longer uses it; [docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md) still builds it for a Railway setup | A self-hoster's Railway project |

## Routing

The production proxy (`convex-host/Caddyfile`) sends the listed HTTP action prefixes to the backend's port 3210 under `/http/` and everything else to 3210 as it is. It never uses the site port 3211; the Caddyfile explains why. A new HTTP route outside the listed prefixes needs a line there.

## Working against the deployment

`packages/convex/.env.local` names the deployment (`CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`). Push functions only through `./dev.sh` (the gated pusher) or `packages/convex/deploy.sh`, never a raw `convex dev` or `convex deploy`: a push sends the whole tree, so one from a stale checkout deletes newer functions.

## Tests

CI's `test-always` job runs `artifact-edge/worker.test.js`, `replay-player/src/clock.test.ts` and `call-face-worker/turns.test.mjs`. `replay-player/src/worker.test.ts` needs `bun install` in that directory first, and `call-face-worker/vision.test.mjs` needs a local LiveKit server; run those two by hand.
