# Slack ↔ chat mirroring

A codecast chat channel can mirror a Slack channel in either or both directions. People who live in Slack keep talking there; the conversation appears in codecast chat, and what the team and its agents say in chat appears in Slack. This is the adoption ramp: nobody has to move before the team gets value.

Shipped 2026-09-14 (plan pl-672). Backend `packages/convex/convex/slackSync.ts`, `lib/slackText.ts`, `lib/slackOutbound.ts`; web `components/chat/SlackSyncDialog.tsx`, `SlackMirrorPill.tsx`, marks in `ChatMessage.tsx`; CLI `cast chat slack`.

## Objects

- **`slack_installations`** (pre-existing, from the anchor). One per Slack workspace, bound to a codecast team (or a personal anchor). Holds the bot token. Gains `bridge_user_id`: the synthetic identity (`users.is_bot`, `bot_kind: "slack"`) that Slack people with no codecast account speak through.
- **`slack_channel_links`**: one row per mirrored pair. `team_id` routes; access to the row follows access to its chat channel. Carries `direction` and `options` (threads, reactions, edits, files, bot_messages, system_messages, agent_lines, match_people_by_email), `paused`, `since_ts`, and status counters. A Slack channel mirrors at most one chat channel and vice versa; both rules are checked inside the one write transaction (`commitLink`).
- **`slack_users`**: profile cache per (workspace, Slack user). `codecast_user_id` is the teammate whose email matches, recomputed on refresh.
- **`slack_sync_events`**: the inbound job ledger. The webhook acks in one mutation; the action that does the work runs from this row and retries up to three times.
- **`chat_messages.external`**: Slack provenance. `direction: "inbound"` is a line written in Slack; its `client_id` is `slack:<workspace>:<channel>:<ts>`, so the existing `by_channel_client_id` index is the lookup for edits, deletes and reactions. `direction: "outbound"` is a codecast line the bot posted; `ts` is stamped after the post. `external_author` is the snapshot of the Slack person when the row's author is the bridge. `sync_local_only` marks a line its author kept out of Slack.

## Naming

A mirrored channel wears the Slack channel's name. `commitLink` renames the chat channel to the Slack name when the link is made (unless another channel in the team already holds that name, in which case the chat name stays), and the `channel_rename` event renames it again when Slack does. `chat.updateChannel` refuses to rename a linked channel and points at Slack. So the two sides never need a second label: in the rail, the sidebar, the header and the mobile channel list, the channel shows its name plus the small Slack mark, and the tooltip (or accessibility label) carries the mirror's state. The settings summary and the dialog subtitle name the far side as just "Slack" while the names match, and spell the Slack name out only when a taken name kept them apart. The header pill is the mark and a state dot, nothing to read twice. The CLI's link success line prints the name the channel now carries.

## Inbound

`POST /api/webhooks/slack` verifies the signature and calls `slackSync.ingestEvent` first. It dedupes on event id, resolves the link by (workspace, channel) and either handles the event inline (rename, archive, uninstall) or inserts a job and schedules `processEvent`. It answers `no_link` **without** recording the event so the legacy anchor path in `http.ts` can still take a mention or DM in an unmirrored channel. In a mirrored channel the `app_mention` event is dropped: the mirrored line's `@handle` wakes the anchor through chat, and the reply mirrors back into the Slack thread.

`processEvent` (action) drops the bot's own events by bot user id and app id, applies the link's flags, resolves the author (`resolvePerson`: cache, else `users.info`), converts the text (`slackToMarkdown` plus `slackAttachmentsToMarkdown` for bot cards), downloads images into storage, and brings a missing thread root over before a reply. It then calls `applyInboundMessage`, which inserts through `chat.postChatMessage` so mentions, read marks, notifications and the anchor wake behave as for a typed line. Backfilled and system lines pass `live: false`: they are stored as `history`, which skips the whole announce step (no bell, no phone banner, no Threads inbox entry, no read mark) and wakes nobody. The web's toast policy (`chatToastTier`) applies the same rule on its side: a mirrored line that reached the client long after its own stamp (`isHistoryLine`) is an import, not something just said. Edits patch only rows whose `external.direction` is inbound (Slack also reports our own `chat.update` as `message_changed`); deletes tombstone inbound rows and detach outbound ones; reactions are inserted under the mapped teammate or the bridge.

## Outbound

`lib/slackOutbound.queueSlackOutbound` is the one decision point. `postChatMessage`, `editMessage`, `deleteMessage`, `toggleReaction` and `replyAsAnchor` (when the answer lands) call it. It reads the channel's link and answers with a skip reason or schedules `pushMessage` / `pushEdit` / `pushDelete` / `pushReaction`. `outboundSkipReason` is pure so a client can predict the server's answer.

`pushMessage` posts as the bot with the author's name and avatar (`chat:write.customize`), threads by the root's Slack ts, adds `reply_broadcast` for a broadcast reply, renders images as image blocks, converts mentions to `<@U>` where the teammate is known in that workspace, and turns `ct-`/`pl-`/`tr-` ids into links. It then stamps `external` on the row with the ts and permalink. A `not_in_channel` error joins a public channel once and retries; fatal errors pause the link with the reason.

## Identity

- A Slack person whose Slack email matches a team member IS that member when `match_people_by_email` is on: the row's `user_id` is the teammate, and the row still carries `external` so the UI shows the Slack mark.
- Anyone else is the bridge identity plus `external_author`. The web renders the snapshot's name and face (`lib/chatViews.slackAuthorFor`), a Slack app with no face gets the Slack mark as its avatar, and the row wears an "app" chip.
- `<@U>` mentions in Slack text become `@handle` only for mapped teammates. Everyone else becomes `**@‌Name**` with a zero width space after the `@`, so a Slack name can never page a codecast teammate who happens to share it. The bot's own `<@U_bot>` becomes the team anchor's handle.
- The other way, a codecast line may name a Slack person who has no codecast account. `resolveChatMentions` tries a handle nobody here answers to against the workspace's `slack_users` (their Slack @name, index `by_workspace_handle`) and stores a `{ kind: "slack", user, handle, name }` ref; the row renders it as a person chip wearing the Slack mark, and `pushMessage` writes the real `<@U>` so they are paged in Slack. A Slack person already matched to a teammate resolves to the teammate instead. The composer offers these people in its @ popup (store `chatSlackPeople`, fed by `listSlackPeople`) with the Slack mark beside the name.
- Every inbound line by an unmatched person is written by the one bridge user, so nothing may group or dedupe on `user_id` alone: the timeline groups by the rendered identity (`@codecast/shared/chat` `authorGroupKey`), and thread faces dedupe by the same key (`threadFaceKey`), on the server rollup and both clients.
- Outbound, agents are named `Name (agent)` or `Title (agent · via Human)` so a Slack reader never mistakes a machine for the teammate hosting it.

## Controls

- **Per channel** (`SlackSyncDialog`, from the header pill or the channel menu): connect the workspace (team admins; one click), pick the Slack channel (public ones are joined automatically; private ones need `/invite @Codecast` first), direction, every content flag, a backfill window, pause, unlink, recent job ledger with plain-language skip reasons. Writes are optimistic store actions (`updateChatSlackLink`, `unlinkChatSlack`); the link itself is an action because it probes Slack first.
- **Per line**: the composer's Slack switch keeps one line home (`sync_local_only`); the message menu offers "Share to Slack" for a line that stayed local or predates the mirror, and "Open in Slack" for any mirrored line.
- **Team**: Settings → Integrations shows the workspace and every mirrored channel.
- **CLI**: `cast chat slack [ls|channels|add|link|unlink|pause|resume]`, every verb with `--json`.

## Bringing channels over (the channel browser)

`SlackChannelBrowser` (Settings → Integrations → Slack → "Add channels from Slack", and "Add from Slack" in the chat rail's new channel modal) lists the connected workspace's channels busiest first, with purpose, member count and creation month, the ones already mirrored under their own heading. Tick any number, pick one history window and one direction, add. Each picked channel goes through `linkChannel` with no `chat_channel_id`: the action creates the codecast channel from the Slack channel (same name, Slack's purpose as the topic, `client_id` `slack:<channel id>` so a retry lands on the same row) and links it. A codecast channel that already carries the name becomes the mirror instead of a duplicate; the row says "joins #name" up front. Private channels the app is not in are greyed with the `/invite @Codecast` hint.

History windows (`lib/slackMirror.BACKFILL_WINDOWS`): from now, last day, week, month (the default), three months, everything. The import runs one page of roots (and their replies) per scheduled action with Slack's cursor, caps at 25,000 lines, and writes `backfill {status, fetched, capped}` on the link after every page. The browser rows, the settings card and `cast chat slack ls` read that field, so a running import shows its count climbing. A failed import (Slack error) pauses the link; Resume runs it again from the link's floor, and lines already here dedupe on their Slack ts. "Everything" sends no `oldest` to Slack (Slack rejects `oldest=0`).

CLI: `cast chat slack add <#slack-channel>... [--history 30d] [--direction both]` is the same import from the terminal.

## Private channels

The app can only see a private channel it is in. Rather than asking for a manual `/invite`, a person connects their own Slack account once (Settings → Integrations → Slack, or the "Connect your Slack account" step inside the channel browser). That is the same OAuth flow with `user_scope=channels:read,groups:read,groups:write,users:read`; the resulting `xoxp` token lands in `slack_user_tokens` keyed by installation and person, and is refused if Slack answered for a different workspace than the team's. The team install's admin gets their token in the same install. The token does exactly one thing: `listSlackChannels` lists the private channels the person is in (rows carry `you_are_in`), and `linkChannel` probes such a channel through the person's view and runs `conversations.invite` as them to bring the bot in, then continues with the bot token. It never reads or posts messages.

## People

`slack_users.codecast_user_id` says who a Slack person is here; `mapped_by` says how it was decided. The email rule sets `"email"` and is recomputed on every profile refresh. The People popup (`SlackPeopleDialog`, from the channel dialog, the settings card and the browser's footer after an import) lets a team admin match any Slack person to any teammate, or pin "keep the Slack name"; a member may claim a Slack account as themselves or release one that points at them. Such a choice is `"manual"`, wins over the link's email switch, survives refreshes, and `reattributeSlackPerson` re-authors that person's past inbound lines across the team's mirrored channels, one page per run, so a match applies to history as well as to what comes next.

Signing in to Slack from codecast (the per-person token behind private channels, `slack.storeUserToken`) is the strongest identity proof there is: Slack itself names the Slack user. `linkSignedInPerson` maps that Slack account to the signed-in teammate as a `"manual"` choice, seeding a profile row if the person has never been seen, so a teammate whose Slack address differs from their codecast one is matched without anyone opening the People popup.

## Direct messages

A connected person can switch on their DMs (Settings → Integrations → Slack, or the channel browser; `cast chat slack dms on`). The switch needs the DM scopes on their token (`im:read`, `im:history`, `mpim:read`, `mpim:history`, `chat:write`); a token from before asks Slack for them once. `scanDms` lists their DMs through their token, one page per run, and links every DM with at least one line in the chosen window: `commitDmLink` makes the codecast DM room (`chat.ensureDmRoom`, the same helper `openDm` and the anchor use) between the owner and each other person's identity here, and a `slack_channel_links` row with `kind: "dm"` and `owner_user_id`. From there it is the channel machinery: the import, live events, edits, reactions, progress. Two things differ. `installForLink` hands the mirror code the owner's token in the app's place, because only the owner can read their DM. And `pushContext` posts a codecast reply into the DM as its author, through the author's own token, plain; an author without a token keeps their line home.

A Slack person with no codecast account speaks in a DM through a shadow identity (`slack_users.shadow_user_id`: a bot user with their Slack name and face, a hidden team member), so two such people never share a room. When that person is later matched to a teammate (or released), `retargetPersonRooms` re-keys their DM rooms to the new identity or merges into the pair's existing room, and `reattributeSlackPerson` re-authors the lines.

Live DM lines arrive as user events (`message.im`, `message.mpim`, declared in the app manifest under `event_subscriptions.user_events`) with the owner in `authorizations`. A line in a DM that has no room yet is adopted on the spot (`adoptDm`: room from now, event replayed) when the owner's DMs are on. A line codecast posted as the person comes back as an ordinary user event; the outbound stamp on the row is what marks it as ours.

Switching DMs off pauses that person's DM links; rooms and lines stay.

## Rooms that already existed here

A mirror never makes a second room for a conversation you already have.

A direct message is identified by its member set (`chat.ensureDmRoom`, the same helper `openDm` and the anchor use), so your Slack DM with a teammate lands in the codecast DM you already had with them: one room, both histories, interleaved by time. A channel keeps its own room too, and takes the Slack channel's name (`adoptSlackName`), so #team stays one #team holding both sides.

The one case that does make a second room is a Slack person nobody has matched to a teammate yet: they speak through a shadow identity, so their DM opens as its own room under their Slack name. Matching them (People popup, or `cast chat slack map`) merges it: `retargetPersonRooms` moves the lines into the room you already had with that teammate, repoints the link, and drops the duplicate. The surviving room adopts the dropped room's id as its `client_id`, which is the same forwarding address an optimistic create uses, so a reader standing in the room that just merged follows it rather than landing on a dead id.

The client keeps a second copy of this rule. Its channel cache only ever grows, so a room the server stopped listing would linger in the rail as a duplicate. `selectChatRail` therefore drops any room absent from the rail once `isChatRailLive()` says a server payload has landed in this page load; a cold rail means nothing yet, and an optimistic stub has no server row to be absent from. The cache itself is left alone on purpose: `pruneAbsentScope` writes durable tombstones, and an empty payload for one beat would hide healthy rooms for good.

## History is not unread

An imported line was read where it was written, often months ago; arriving here is a move, not an event. `railFor` therefore excludes history from both unread numbers, using the derived `isHistoryLine` (`@codecast/shared/chat`: the line was synced more than five minutes after it was written) rather than a stored flag, so the rule applies to rooms that were imported before it existed. Imported lines also skip `announceChatMessage`, so they notify nobody. A line that arrives live in a mirrored room is synced as it is written, so it counts normally.

## Install flow

`slack.getInstallUrl` signs a state carrying the scope, `return_to` and the allowlisted web `origin`; Slack returns to `<origin>/slack/connect`, which completes the exchange in the signed-in session and bounces to `return_to?slack=connected|error`. One trap on that return: `@convex-dev/auth` reads any `?code=` in the URL at boot as one of its own sign in codes, redeems it, fails, and signs the person out. `boot.tsx` therefore runs `lib/slackReturn.stashSlackReturn()` before React mounts, which moves Slack's code into session storage and rewrites the URL; the connect page takes it from there (`takeSlackReturn`). A team install requires a team admin and no longer requires an anchor. The redirect URIs registered on the Slack app are production, `https://local.codecast.sh` and `http://localhost:3200`.

## Validated live (2026-09-15, Union workspace)

App `A0C1S67PH2A` created from `docs/architecture/slack-app-manifest.json`, installed to Union through the team install, `#slack-mirror-test` linked to Slack `#testing` with `cast chat slack link`. Proven against Slack's own API and the chat rows:

- codecast line → Slack post with `*bold*`, `_italic_`, `<url|label>`, the author's name, and the row stamped `external.direction: "outbound"` with ts and permalink;
- Slack message event → inbound row with converted markdown, emoji, an `external_author` snapshot, `client_id` `slack:<ws>:<ch>:<ts>`;
- Slack reply under a codecast root → threaded under it (found by the `by_channel_external_ts` index); codecast reply in that thread → Slack thread (`thread_ts` = root's ts);
- Slack reaction → `chat_reactions` row; codecast reaction → Slack `eyes` on the post;
- Slack edit → inbound row patched and marked edited; other apps' lines skipped while `bot_messages` is off; our own echoes dropped at ingest.

Two things bit during setup and are fixed in code: `chat.getPermalink` rejects a JSON body (the API helper now sends JSON only to `chat.postMessage`, `chat.update`, `chat.delete` and `reactions.*`), and the signed OAuth state's replay window was five minutes, shorter than a slow consent screen; it is now ten, matching the lifetime of Slack's code.

## Edges, acknowledged

- Two Slack people reacting with the same emoji on a line show as one bridge reaction.
- Reactions from codecast appear in Slack as the app's, not the person's (Slack has no per-user impersonation for reactions).
- Slack files that are not images arrive as links to Slack (a Slack login is needed to open them). Images up to 20 MB are copied into storage.
- Voice bursts and huddle digests are not mirrored.
- Slack `blocks` are converted from the `text` fallback, so a Block Kit layout arrives as its text.
- Ordering under a burst is by processing order, not Slack ts, for live lines; backfill keeps Slack time.
