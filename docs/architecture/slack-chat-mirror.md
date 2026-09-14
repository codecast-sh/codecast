# Slack ↔ chat mirroring

A codecast chat channel can mirror a Slack channel in either or both directions. People who live in Slack keep talking there; the conversation appears in codecast chat, and what the team and its agents say in chat appears in Slack. This is the adoption ramp: nobody has to move before the team gets value.

Shipped 2026-09-14 (plan pl-672). Backend `packages/convex/convex/slackSync.ts`, `lib/slackText.ts`, `lib/slackOutbound.ts`; web `components/chat/SlackSyncDialog.tsx`, `SlackMirrorPill.tsx`, marks in `ChatMessage.tsx`; CLI `cast chat slack`.

## Objects

- **`slack_installations`** (pre-existing, from the anchor). One per Slack workspace, bound to a codecast team (or a personal anchor). Holds the bot token. Gains `bridge_user_id`: the synthetic identity (`users.is_bot`, `bot_kind: "slack"`) that Slack people with no codecast account speak through.
- **`slack_channel_links`**: one row per mirrored pair. `team_id` routes; access to the row follows access to its chat channel. Carries `direction` and `options` (threads, reactions, edits, files, bot_messages, system_messages, agent_lines, match_people_by_email), `paused`, `since_ts`, and status counters. A Slack channel mirrors at most one chat channel and vice versa; both rules are checked inside the one write transaction (`commitLink`).
- **`slack_users`**: profile cache per (workspace, Slack user). `codecast_user_id` is the teammate whose email matches, recomputed on refresh.
- **`slack_sync_events`**: the inbound job ledger. The webhook acks in one mutation; the action that does the work runs from this row and retries up to three times.
- **`chat_messages.external`**: Slack provenance. `direction: "inbound"` is a line written in Slack; its `client_id` is `slack:<workspace>:<channel>:<ts>`, so the existing `by_channel_client_id` index is the lookup for edits, deletes and reactions. `direction: "outbound"` is a codecast line the bot posted; `ts` is stamped after the post. `external_author` is the snapshot of the Slack person when the row's author is the bridge. `sync_local_only` marks a line its author kept out of Slack.

## Inbound

`POST /api/webhooks/slack` verifies the signature and calls `slackSync.ingestEvent` first. It dedupes on event id, resolves the link by (workspace, channel) and either handles the event inline (rename, archive, uninstall) or inserts a job and schedules `processEvent`. It answers `no_link` **without** recording the event so the legacy anchor path in `http.ts` can still take a mention or DM in an unmirrored channel. In a mirrored channel the `app_mention` event is dropped: the mirrored line's `@handle` wakes the anchor through chat, and the reply mirrors back into the Slack thread.

`processEvent` (action) drops the bot's own events by bot user id and app id, applies the link's flags, resolves the author (`resolvePerson`: cache, else `users.info`), converts the text (`slackToMarkdown` plus `slackAttachmentsToMarkdown` for bot cards), downloads images into storage, and brings a missing thread root over before a reply. It then calls `applyInboundMessage`, which inserts through `chat.postChatMessage` so mentions, read marks, notifications and the anchor wake behave as for a typed line. Backfilled and system lines pass `live: false` and wake nobody. Edits patch only rows whose `external.direction` is inbound (Slack also reports our own `chat.update` as `message_changed`); deletes tombstone inbound rows and detach outbound ones; reactions are inserted under the mapped teammate or the bridge.

## Outbound

`lib/slackOutbound.queueSlackOutbound` is the one decision point. `postChatMessage`, `editMessage`, `deleteMessage`, `toggleReaction` and `replyAsAnchor` (when the answer lands) call it. It reads the channel's link and answers with a skip reason or schedules `pushMessage` / `pushEdit` / `pushDelete` / `pushReaction`. `outboundSkipReason` is pure so a client can predict the server's answer.

`pushMessage` posts as the bot with the author's name and avatar (`chat:write.customize`), threads by the root's Slack ts, adds `reply_broadcast` for a broadcast reply, renders images as image blocks, converts mentions to `<@U>` where the teammate is known in that workspace, and turns `ct-`/`pl-`/`tr-` ids into links. It then stamps `external` on the row with the ts and permalink. A `not_in_channel` error joins a public channel once and retries; fatal errors pause the link with the reason.

## Identity

- A Slack person whose Slack email matches a team member IS that member when `match_people_by_email` is on: the row's `user_id` is the teammate, and the row still carries `external` so the UI shows the Slack mark.
- Anyone else is the bridge identity plus `external_author`. The web renders the snapshot's name and face (`lib/chatViews.slackAuthorFor`), a Slack app with no face gets the Slack mark as its avatar, and the row wears an "app" chip.
- `<@U>` mentions in Slack text become `@handle` only for mapped teammates. Everyone else becomes `**@‌Name**` with a zero width space after the `@`, so a Slack name can never page a codecast teammate who happens to share it. The bot's own `<@U_bot>` becomes the team anchor's handle.
- Outbound, agents are named `Name (agent)` or `Title (agent · via Human)` so a Slack reader never mistakes a machine for the teammate hosting it.

## Controls

- **Per channel** (`SlackSyncDialog`, from the header pill or the channel menu): connect the workspace (team admins; one click), pick the Slack channel (public ones are joined automatically; private ones need `/invite @Codecast` first), direction, every content flag, a backfill window, pause, unlink, recent job ledger with plain-language skip reasons. Writes are optimistic store actions (`updateChatSlackLink`, `unlinkChatSlack`); the link itself is an action because it probes Slack first.
- **Per line**: the composer's Slack switch keeps one line home (`sync_local_only`); the message menu offers "Share to Slack" for a line that stayed local or predates the mirror, and "Open in Slack" for any mirrored line.
- **Team**: Settings → Integrations shows the workspace and every mirrored channel.
- **CLI**: `cast chat slack [ls|channels|link|unlink|pause|resume]`.

## Install flow

`slack.getInstallUrl` signs a state carrying the scope, `return_to` and the allowlisted web `origin`; Slack returns to `<origin>/slack/connect`, which completes the exchange in the signed-in session and bounces to `return_to?slack=connected|error`. A team install requires a team admin and no longer requires an anchor. The redirect URIs registered on the Slack app are production, `https://local.codecast.sh` and `http://localhost:3200`.

## Edges, acknowledged

- Two Slack people reacting with the same emoji on a line show as one bridge reaction.
- Reactions from codecast appear in Slack as the app's, not the person's (Slack has no per-user impersonation for reactions).
- Slack files that are not images arrive as links to Slack (a Slack login is needed to open them). Images up to 20 MB are copied into storage.
- Voice bursts and huddle digests are not mirrored.
- Slack `blocks` are converted from the `text` fallback, so a Block Kit layout arrives as its text.
- Ordering under a burst is by processing order, not Slack ts, for live lines; backfill keeps Slack time.
