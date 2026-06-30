# Anchor — activation & deploy runbook

The Anchor feature (a persistent agent member per workspace) is built on the branch
`codecast/anchor`. This is how it ships and how it gets switched on. Design context:
`docs/aivery-on-codecast.md`.

## What's in this branch

- **Schema** (`packages/convex/convex/schema.ts`): `anchors`, `anchor_channels`, `slack_events`
  tables; `users.is_bot`/`bot_kind`; `conversations.persistent`/`acting_user_id`/`anchor_id`.
  All additive — new tables and new optional fields only, no migration.
- **Core** (`anchors.ts`): `provisionAnchor`, `wakeAnchor`/`wakeAnchorInternal`,
  `resolveAnchorForScope`, `listAnchors`; the never-complete guard in
  `conversations.markSessionCompleted`; bot-identity rendering in `webGet`/`listConversations`
  + `liveEntities.resolveSessionAuthor`.
- **Slack** (`slack.ts`, `http.ts`): `/api/webhooks/slack` (HMAC v0 verify, replay window,
  event dedup) → wakes the channel's anchor; `linkChannel`/`postMessage`; CLI `cast anchor
  link-channel` / `say`.
- **CLI** (`packages/cli/src/index.ts`): `cast anchor create | ls | wake | link-channel | say`.

## Deploy (production)

Order matters: the Convex backend and the CLI must be live before an anchor can run.

1. **Land on main.** A `convex dev` watcher runs from the main checkout and continuously
   pushes main's Convex state to prod — so Convex deploys when this merges to main (not from
   the worktree, which the watcher would revert). Rebase on `origin/main`, then merge.
   - Web auto-deploys via Railway on push to main (no separate step).
   - The new schema is additive, so the push is safe (no table/field removed).
2. **Release the CLI.** `cast anchor *` and the daemon ship in the CLI — cut a CLI release so
   users (and the always-on host daemon) get the new commands. The daemon itself is unchanged
   by this feature, so no daemon-behavior risk.
3. **Set Convex env vars** (only needed for Slack):
   - `SLACK_SIGNING_SECRET` — verifies inbound webhooks.
   - `SLACK_BOT_TOKEN` — posts replies as the bot.

## Provision the first anchors

```bash
cast anchor create                 # your personal Anchor, in the current project
cast anchor create --team          # your active team's shared Anchor
cast anchor ls                     # see them
cast anchor wake "what's your status?"   # poke it (auto-resumes if dormant)
```

The anchor comes online (pinned, persistent, rendered under its bot identity), records its
role to its project memory, and stands by. It delegates code work with `cast spawn` and checks
the results — no extra wiring.

## Activate Slack (the one part that needs your hands)

1. Create a Slack app (api.slack.com/apps) for the workspace.
2. **Event Subscriptions** → Request URL: `https://convex.codecast.sh/api/webhooks/slack`
   (Slack will hit it with a `url_verification` challenge — the route answers it). Subscribe to
   bot events: `app_mention`, and `message.im` for DMs.
3. **OAuth scopes**: `app_mentions:read`, `chat:write`, `im:history` (+ `channels:history` if
   you want channel DMs). Install to the workspace; copy the Bot Token (`xoxb-…`).
4. Set `SLACK_SIGNING_SECRET` (Basic Information → Signing Secret) and `SLACK_BOT_TOKEN` in
   Convex env.
5. Invite the bot to a channel, then map it:
   ```bash
   cast anchor link-channel C0123ABCD --team    # @mentions in C0123 wake the team anchor
   ```
6. `@Anchor` in that channel → it wakes, works, and replies in-thread as the bot.

## Validate end to end (post-deploy)

- `cast anchor create` → `cast anchor ls` shows it `active` with a session id.
- Open the inbox: the anchor is pinned at the top, rendered as its bot name/avatar, and stays
  pinned/active even after it goes idle (it never flips to "completed").
- `cast anchor wake "spawn a hand to list this repo's top-level dirs and report back"` →
  watch it `cast spawn` a session and summarize the result.
- (Slack) `@Anchor hello` in a linked channel → a threaded reply from the bot.

## Deferred to follow-ups (not in v1)

- **`session_idle` auto-wake** of an anchor when a delegated hand finishes (v1 uses the
  by-hand path: the anchor checks `cast sessions`/`cast read`, or the hand `cast send`s back).
- **Daemon `--append-system-prompt` persona seam** (v1 persona = bootstrap message + project
  skill/CLAUDE.md).
- **`is_bot` rendering polish / no-self-notify** and **per-anchor spend caps** (the
  `daily_session_cap` field exists; enforcement is a follow-up).
- **Multi-workspace Slack** (v1 = one app, one signing secret + bot token).
