# Agent Notes

## Dev Server

Run dev server:
```bash
./dev.sh      # http://local.codecast.sh (usually already running at this address)
./dev.sh 1    # http://local.1.codecast.sh
./dev.sh 2    # http://local.2.codecast.sh
```

## Test Credentials
For testing the web app locally see email and password in packages/web/.env.local as TEST_USER_EMAIL and TEST_USER_PASSWORD.

## CLI Commands

```bash
# Search & Browse (quotes = exact phrase, no quotes = all words anywhere)
codecast search auth                  # finds "auth" anywhere
codecast search "error handling"      # exact phrase match
codecast search bug -g -s 7d          # global, last 7 days
codecast feed                         # browse recent conversations
codecast read <id> 15:25              # read messages 15-25

# Analysis
codecast diff <id>                    # files changed, commits, tools used
codecast diff --today                 # aggregate today's work
codecast summary <id>                 # goal, approach, outcome, files
codecast context "implement auth"     # find relevant prior sessions
codecast ask "how does X work"        # query across sessions

# Handoff & Tracking
codecast handoff                      # generate context transfer doc
codecast bookmark <id> <msg> --name x # save shareable link
codecast decisions list               # view architectural decisions
codecast decisions add "title" --reason "why"
```

Common options: -g (global), -s/-e (start/end: 7d, 2w, yesterday), -p (page), -n (limit)

## Deployment

### Full Deploy (recommended)
```bash
./scripts/deploy-all.sh
```
Deploys everything: Convex functions, CLI (if changed), and pushes to git (which triggers Railway auto-deploy for web).

We use dev convex instance for dev and for prod, not prod instance.

### CLI-Only Release
```bash
cd packages/cli
# 1. Bump version in package.json AND src/update.ts (must match!)
# 2. Deploy (builds binaries and uploads to R2)
./scripts/deploy.sh              # normal release, users update manually
./scripts/deploy.sh --force      # force all remote clients to auto-update
# 3. Verify: curl -fsSL codecast.sh/install | sh && codecast --version
# 4. Commit, tag, push
git tag -a v1.0.X -m "release(cli): v1.0.X"
git push origin v1.0.X
```

Use `--force` for critical updates or breaking changes. Remote daemons will auto-update within 5 minutes.

### Web App (Railway)
The web app auto-deploys on push to main via Railway. No manual deploy needed.
- Production: https://codecast.sh
- Railway dashboard: https://railway.app

## Logs

```bash
./scripts/logs.sh              # Stream Railway + Convex
./scripts/logs.sh -e           # Errors/warnings only
./scripts/logs.sh -r           # Railway only
./scripts/logs.sh -c           # Convex only
./scripts/logs.sh -r -n 50    # Last 50 Railway lines
./scripts/logs.sh -s 30m      # Railway logs from last 30 min
```

`deploy-all.sh` automatically tails Railway logs after deploy completes.

## Debugging Lessons

### Convex Auth Issues
- When debugging Convex Auth (OAuth, login issues), check `npx convex logs` FIRST before investigating client-side redirect flows
- The `profile` function in Convex Auth providers MUST return an `id` field as a string
- Error "The profile method of the github config must return a string ID" means you're missing the `id` field in your profile return object
