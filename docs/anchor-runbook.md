# Anchor: activation and operations runbook

The Anchor is the workspace's standing agent: one persistent agent member per
workspace (personal or team). It is now seated as the workspace's **root role**,
Head of People by default, so `cast anchor` is an alias over the org's roles
(`cast role`, `cast org staff`). It is on main. Design context:
`docs/aivery-on-codecast.md` and `docs/architecture/org-staffing.md`.

Every `cast anchor` command and the web surfaces sit behind the **org** team
feature (`teams.features.org`, off by default). A workspace without it gets the
feature's refusal, not an empty list.

## What's in it

- **Schema** (`packages/convex/convex/schema.ts`): `anchors`, `anchor_channels`, `slack_events`,
  `slack_installations` tables; `users.is_bot`/`bot_kind`; `conversations.persistent`/`acting_user_id`/`anchor_id`.
- **Core** (`anchors.ts`): `provisionStandingAgent` (seating), `wakeAnchor`, `rebriefAnchor`,
  `resolveAnchorForScope`, `listAnchors`, `decommissionAnchor`; the never-complete guard in
  `conversations.markSessionCompleted` (a `persistent` row never completes); bot-identity rendering
  in `webGet`/`listConversations` + `liveEntities.resolveSessionAuthor`.
- **Slack** (`slack.ts`, `http.ts`): `/api/webhooks/slack` (HMAC v0 verify, replay window,
  event dedup) wakes the channel's anchor; `linkChannel`/`postMessage`; per-workspace bot tokens
  from the "Add to Slack" install in `slack_installations`.
- **CLI** (`packages/cli/src/index.ts`): `cast anchor create | ls | wake | brief | rm | link-channel | say`.

## Deploying changes to it

The ordinary rules in the repo's `CLAUDE.md` apply; nothing about the anchor is special.

1. **Convex first.** Deploy with `packages/convex/deploy.sh` (never raw `npx convex deploy`) before
   pushing a commit whose web code calls a new Convex function. Web auto-deploys via Railway on
   push to main.
2. **CLI release** for changes to `cast anchor *` or the daemon:
   `gh workflow run cut-cli-release.yml -R codecast-sh/codecast`.
3. **Convex env vars** (only needed for Slack):
   - `SLACK_SIGNING_SECRET`: verifies inbound webhooks.
   - `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`: the "Add to Slack" OAuth install.
   - `SLACK_REDIRECT_BASE` (optional): overrides the Convex site URL used in Slack callbacks.

## Seat an anchor

```bash
cast anchor create                 # your personal workspace's agent, working in the current project
cast anchor create --team          # your active team's agent (or --team <name|id>)
cast anchor create -C ~/src/app    # pick the project it lives and works in
cast anchor ls                     # the workspace agents you can see
cast anchor wake "what's your status?"          # message it (auto-resumes if dormant); --team for the team's
cast anchor brief [--team]         # re-send its standing briefing
```

`create` is idempotent per workspace: if the workspace already has its agent, it says so and
names the role (`cast role show <handle>`). The agent comes online pinned and persistent,
rendered under its bot identity, and stands by. It delegates code work with `cast spawn` and
checks the results.

## Activate Slack

The same Slack app powers channel mirroring (`docs/architecture/slack-chat-mirror.md`), so it
asks for the full `BOT_SCOPES` list in `slack.ts`, not just what the anchor needs.

1. On the Slack app (api.slack.com/apps): **Event Subscriptions** Request URL
   `https://convex.codecast.sh/api/webhooks/slack` (the route answers Slack's `url_verification`
   challenge). Subscribe to bot events `app_mention` and `message.im`, plus the mirror's:
   `message.channels`, `message.groups`, `reaction_added`, `reaction_removed`, `channel_rename`,
   `channel_archive`, `channel_unarchive`, `channel_deleted`, `member_joined_channel`,
   `member_left_channel`, `user_change`, `app_uninstalled`, `tokens_revoked`.
2. **OAuth redirect URLs**: `<web origin>/slack/connect` for `https://codecast.sh`,
   `https://local.codecast.sh` and `http://localhost:3200`. Those are the only origins an install
   may return to.
3. Set the env vars above in Convex.
4. **Install**: a team admin clicks **Add to Slack** in the workspace agent's settings (on
   `/anchor`). The install binds to the team and does not need an anchor to exist first.
5. **Invite the bot to the channel in Slack first** (`/invite @<bot>`), then map it:
   ```bash
   cast anchor link-channel C0123ABCD --team    # @mentions in C0123ABCD wake the team's agent
   ```
   Linking is rejected unless the bot is already a channel member, which is what stops anyone
   claiming a channel's routing without the bot being invited there.
6. `@<bot>` in that channel: it wakes, works, and replies in-thread as the bot.

To retire an anchor: `cast anchor rm` (alias `decommission`; `--team` for the team's). It clears
persistence, kills the host session, drops channel mappings and the bot's team seats, and frees
the scope so `cast anchor create` can seat a new one. Only an admin or the host can retire it.

## Validate end to end

- `cast anchor create` then `cast anchor ls` shows it with a session id.
- Open the inbox: the anchor is pinned, rendered as its bot name/avatar, and stays
  pinned/active even after it goes idle (it never flips to "completed").
- `cast anchor wake "spawn a hand to list this repo's top-level dirs and report back"`, then
  watch it `cast spawn` a session and summarize the result.
- (Slack) `@<bot> hello` in a linked channel gets a threaded reply from the bot.

## Known edges (acknowledged, bounded)

- **Channel-link verification checks the bot's membership, not the caller's.** Linking requires
  the bot to already be in the channel, and re-pointing an existing mapping requires controlling
  it. But the bot token cannot establish the *caller's* Slack identity, so a codecast user could
  first-claim an unclaimed channel the bot is in even if they aren't a member of it. Within one
  trusted workspace where the bot is invited only to intended channels this is bounded; full
  per-user Slack-identity verification is a follow-up. Keep the bot out of sensitive channels you
  don't want claimable.

- **Slack delivery is at-least-once within Slack's retry window, not absolute.** A wake patches
  the anchor's single long-lived conversation row; if that row is under heavy concurrent write
  (the anchor streaming a long turn while several mentions land at once), a wake mutation can
  exhaust Convex's OCC-retry budget and 500. Slack retries (about 3 times over about 5 minutes),
  so it self-heals in practice, but a sustained hot window is the one path a mention could be
  lost. Revisit by decoupling the durable pending-message insert from the conversation patch if
  anchors get high-volume.

## Not built yet

- **Per-anchor spend caps**: the `anchors.daily_session_cap` field exists; nothing enforces it.
- **Self-notify suppression** for the bot's own rows.
- **Per-user Slack identity** for channel linking (see Known edges).

## In the web app

- **Where it lives.** The header chip and **⌘⇧A** (Ctrl+Shift+A off Mac) or the palette's
  "Talk to the workspace's agent" open a slide-over holding the agent's live conversation from
  any page. `/anchor` is the root role's page: its conversation on one side and its scope
  (routines, settings, Slack) on the other; a workspace with no root role gets onboarding that
  seats one. Store: `anchors` collection (`anchors.listAnchors`), `anchorPanel` ephemeral state,
  `components/anchor/*`.
- **Group chat.** Naming the agent in a thread arms it (`anchor_follow`); from then on every
  reply wakes it silently (a `listening` placeholder nobody sees) with a wake prompt that says to
  pass unless the line is for it. `cast chat reply <id> --pass` closes the row (`passed`); a real
  reply surfaces at the end of the thread. Naming it while it listens promotes the same row to a
  visible turn. Wakes carry the channel topic and recent room lines as well as the thread.
- **Proactive voice.** `chat.sendAsAnchor` / `cast anchor say --chat <channel|#name>
  [--thread <root>]` posts as the agent; `--dm <handle>[,<handle>]` opens (or reuses) a DM room
  whose members are the bot plus those people; `--channel <slack id>` posts in Slack. A 1:1 with
  the agent is answered inline (no thread). Its host may read those rooms
  (`chatAccess.canAccessChannel`). A personal agent DMs in a team named with `--team`.
- **Briefing.** `bootstrapMessage` frames a general agent that states its scope, owns its
  routines via `cast trigger` (bound to its own session), reaches people with `cast anchor say`,
  and passes in group threads. `cast anchor brief [--team]` re-sends it to a running agent.
- **Silent rows never leave the server.** `isSilentAgentRow` (`packages/shared/chat/agent.ts`) is
  applied in getThread, listMessages, thread summaries, unread counts, search and participants.
