# Agent Notes

## Dev Server

Run dev server:
```bash
./dev.sh      # http://local.codecast.sh (usually already running at this address)
./dev.sh 1    # http://local.1.codecast.sh
./dev.sh 2    # http://local.2.codecast.sh
```

## Test Credentials
For testing the web app locally:
- Prefer `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` env vars when running e2e.
- E2e tests fall back to `test@example.com` / `testpass123` if unset.
- If `packages/web/.env.local` defines `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`, use those.

## CLI Commands

```bash
# Search & Browse (quotes = exact phrase, no quotes = all words anywhere)
cast search auth                  # finds "auth" anywhere
cast search "error handling"      # exact phrase match
cast search bug -g -s 7d          # global, last 7 days
cast feed                         # browse recent conversations
cast read <id> 15:25              # read messages 15-25

# Analysis
cast diff <id>                    # files changed, commits, tools used
cast diff --today                 # aggregate today's work
cast summary <id>                 # goal, approach, outcome, files
cast context "implement auth"     # find relevant prior sessions
cast ask "how does X work"        # query across sessions

# Handoff & Tracking
cast handoff                      # generate context transfer doc
cast bookmark <id> <msg> --name x # save shareable link
cast decisions list               # view architectural decisions
cast decisions add "title" --reason "why"
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
# 3. Verify: curl -fsSL codecast.sh/install | sh && cast --version
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

## React: No Direct useEffect

`useEffect` is banned in `packages/web`. The lint rule enforces this. Two escape hatches exist:

- **`useMountEffect(fn)`** — one-time external sync on mount (DOM integration, third-party widgets, browser API subscriptions). If preconditions aren't met, move the mount up the tree behind a conditional render instead of guarding inside the effect.
- **`useEventListener(event, handler, target?, options?)`** — event subscriptions with automatic cleanup. Handler is stable via ref internally.

Five patterns replace everything else:

1. **Derive state, don't sync it.** If you're about to write `useEffect(() => setX(f(y)), [y])`, write `const x = f(y)` instead.

2. **Data fetching belongs in the library.** We use Convex queries (`useQuery`, `usePaginatedQuery`). Never fetch in an effect.

3. **Event handlers, not effects.** If the trigger is a user action, put the logic in the onClick/onChange handler directly.

4. **`key` to reset, not effect choreography.** If a component should start fresh when an ID changes, pass `key={id}` and use `useMountEffect` inside. Don't write `useEffect(() => reset(), [id])`.

5. **Conditional mount over guarded effect.** Instead of `useEffect(() => { if (!ready) return; init() }, [ready])`, render the component only when `ready` is true.

## State Management

All UI state in `packages/web` belongs in `inboxStore` (Zustand global store at `packages/web/store/inboxStore.ts`), not in local component state (`useState`). Before reaching for `useState`, check if the state belongs in `inboxStore` and add it there instead. Local state is only acceptable for purely transient, component-scoped UI concerns (e.g., a controlled input's in-flight value before commit).

### Mutations are local-first via the store

All data mutations (creating, updating, deleting entities) MUST go through `inboxStore` actions, never via direct `useMutation` calls. The pattern:

1. Define an `action()` in `inboxStore.ts` that optimistically mutates the local state
2. Add a matching handler in `packages/convex/convex/dispatch.ts` to persist the change
3. The mutative middleware automatically dispatches to Convex after applying the optimistic update
4. If the server call fails, the middleware rolls back using inverse patches

Example: `pinDoc`, `archiveDoc`, `updateDoc` all follow this pattern. Never use `useMutation(api.*.webUpdate)` directly from components -- that bypasses optimistic updates and creates stale closure bugs with debounced saves.

## Styling: Subdued Text

For subdued/muted text in the UI, use Tailwind grayscale (`text-gray-300`, `text-gray-400`, `text-gray-500`) rather than opacity on theme tokens (`text-sol-text-dim/30`) or `text-black/30`. Theme token opacity modifiers often don't reduce opacity as expected depending on how the CSS variable is defined, and `text-black` won't work in dark themes.

## Debugging Lessons

### Convex Auth Issues
- When debugging Convex Auth (OAuth, login issues), check `npx convex logs` FIRST before investigating client-side redirect flows
- The `profile` function in Convex Auth providers MUST return an `id` field as a string
- Error "The profile method of the github config must return a string ID" means you're missing the `id` field in your profile return object
