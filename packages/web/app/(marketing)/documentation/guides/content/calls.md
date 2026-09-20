A call is the one team artifact an agent could not read. Code is in the repository, tasks are on the board, chat is searchable, and every session leaves a transcript. A decision made out loud leaves nothing behind. A task that says "as we discussed on the call" then points at something no agent can open, so the agent guesses or asks again.

Codecast calls close that gap with a transcript that names its speakers. Every huddle transcribes while it runs, and each line carries the person who said it. When the huddle ends it gets a title, a summary and a list of action items. `cast calls` lets a session read all of it without having been in the room, so "what we discussed on the call" becomes a line an agent can quote with the speaker's name on it.

Codecast owns everything except the media. Rooms, rings, authorization and access tokens live in Convex, and audio and video flow between the clients and a LiveKit server. The calls [snippet](/documentation/agent-snippets) teaches agents the commands below.

```bash
cast calls                        # calls across your teams, live ones first (-n 50 for more)
cast call <id>                    # one call: title, participants, summary, action items
cast call <id> --transcript       # the full transcript, a speaker on every line
cast call <id> --json             # the same as data; always includes the segments
```

`<id>` is a call id from `cast calls`, or a unique prefix of one. A segment in the JSON carries `seq`, `speaker_id`, `speaker_name`, `text`, and its start and end times. You can read a call you took part in, and a call whose room you may enter. A recording of one person's microphone shows in the same list, and it belongs to its creator until they share it with a team.

## Rooms and presence

A room is a string key and never a stored row, so every client derives the same key without coordination.

| Key | What it is | Who the key admits |
|-----|------------|--------------------|
| `dm:<id>:<id>` | A set of 2 to 9 people, ids sorted. A DM and the huddle of its members are the same room | The people it names |
| `channel:<channelId>` | A chat channel's standing room | Whoever may access the channel |
| `session:<convId>` | A huddle about one session | The session's owner, and teammates when the session is visible to the team |

A seat is a lease. A client in a room sends a heartbeat every 15 seconds, and every reader ignores a seat older than 45 seconds, so a closed laptop leaves the room without a cleanup step. A person joins muted, and unmuting is the deliberate act. An occupied room admits any member of its team, the way a meeting room with people in it admits whoever walks up. A channel room is the exception and keeps the channel's own membership. A huddle that wants privacy locks the room. A teammate can knock at a locked room, and anyone inside admits them by ringing them in. Nothing admits a person from outside the team. The server checks these rules in every call mutation and when it mints a media token, because the media server trusts that token.

Presence comes from two facts about a person's machine: how recently the app checked in, and how recently somebody touched the keyboard or mouse. A person reads as active when the app checked in within 150 seconds and there was input within 3 minutes. The states are active, idle, away and offline. A person can declare busy or away, and a declaration wins over what the machine reports. The people wall draws the whole team at once and sizes each face by how present the person is. Click a face and three labeled actions appear under it: Talk, Ring and Message.

## Transcription with exact speakers

Attribution is structural and never inferred. One client in the room is the scribe. It holds every audio track in the room, which is its own microphone plus each remote track, and it streams each track to speech recognition on its own connection. A track belongs to one participant, so each segment is stamped with that participant. The server stores the segments and mints the short lived recognition credentials.

Every huddle transcribes unless somebody inside says otherwise. A client starts a run when it joined on purpose and the room has two or more people, and the server decides which client is the scribe. If the scribe's seat lapses, another client adopts the same run, and the old one lets go so no word lands twice.

Transcription is a switch the room owns. It is a field on the room's state row, and anyone seated may flip it either way. It has to live on the room: a flag held by one client would be overruled by the next client that looked. Turning it off ends the run wherever it lives, and the digest of what was already said still posts.

## The digest

Every finished huddle that has any words leaves a digest where it was held.

| Room | What appears |
|------|--------------|
| A channel or a DM | A chat message from the scribe with the title, the length, the speakers, the summary and the action items. A reader can open the transcript under it. The write is keyed on the transcript, so a retry cannot post a second one |
| A session room | The session's agent wakes with a `<huddle-summary>` message that holds the digest and the command `cast call <id> --transcript`. The words themselves stay on the server, so a long huddle does not arrive as thousands of tokens the agent did not ask for |

A huddle of fewer than 40 words gets no generated summary, and its digest is the words themselves. When the summary cannot be generated, the call is marked `failed`, and the transcript is still readable. Huddle digests do not cross the [Slack mirror](/documentation/team-chat).

## Agents as participants

A session's own room feeds that session live. The server adds the route when the transcript starts, so it holds for every client and for whoever ends up as the scribe. One person alone in a session room is enough to start transcription, because the second party is the agent, and the agent never takes a seat. The words reach the session each time the room goes quiet, on the same delivery path as [`cast send`](/documentation/messaging). Each batch opens with a note that speech arrives in pieces and that the agent should wait for a complete thought. When that huddle ends, the digest tells the agent it already heard the conversation live, so it does not do the work twice.

A participant can also point a huddle at another session, at a doc, or at a linked Slack channel. Each route is either `live` or `after`, which delivers once at the end. Delivery acts as the person who added the route. The server stamps that person itself and never accepts the value from a client, so a scribe cannot write into sessions and docs that only somebody else can reach.

A fed session takes part in the huddle's text chat. The reply it ends a turn with is mirrored into that chat as its own line, cut at 1800 characters with a link to the session. A line a person types there is relayed into the session.

## Walkie

Walkie is push to talk into a DM. Click Talk on a face, in the DM composer or with the keyboard chord, talk, and click again to stop. Talk is a click toggle and not a hold: a press that opened a microphone felt like an accident, so the hold gesture was removed.

One microphone track does three things at once. It goes live into the DM's call room, so a teammate at their desk hears it as it is spoken. It is recorded, so everyone else can play it later. It feeds one recognizer, so the DM shows the words while they are still being said. A chat message is the spine of all three: it opens live when the talk starts, the text streams into it every 2.5 seconds, and it lands with the recording when the talk stops. The microphone opens first and the room joins last, so nothing a person says waits on a connection.

| Behavior | Rule |
|----------|------|
| Shortest burst kept | 700 ms. Anything shorter is discarded |
| Longest burst | 5 minutes, then it lands as a message |
| After a burst | The room stays open 30 seconds in case somebody answers |
| While you are in another huddle | Walkie is unavailable, and the key says so |
| The recognizer is down | The audio still records, and the server transcribes it afterwards |

A burst is one way. The listener hears the talker, and the talker hears nobody back. A burst becomes a call only when somebody steps in on purpose with Join live. That step stamps `walkie_joined_at` on the listener's seat, every client in the room reads the stamp, and the room is a call for as long as it lasts.

A burst plays out loud only when somebody is there to hear it: calls are on, the machine saw input in the last 3 minutes, the person is not busy and has not snoozed or turned the setting off, and the window is the one that speaks for the app. A closed door never blocks delivery. The burst still lands in the DM with its unread count and its notification.

Rooms are prewarmed ahead of a burst. The media connection is the slow part: about 1.0 second into a room the client had already touched, and up to 12.7 seconds into a cold one. So the client connects early, when you open a DM or rest the pointer on a face for 400 ms. It publishes a muted microphone, which makes the later press an unmute and not a new publish. A prewarm proceeds only where microphone permission is already granted, so it can never raise a permission prompt. Its row is marked `prewarm` and no reader counts it as a seat. It holds one room at a time and lets go after 90 seconds.

## Rings on phones

A ring is an invite row that lives 45 seconds. A phone that registered a VoIP token gets the ring as an APNs VoIP push sent straight to Apple. The app's native layer reports it to CallKit before any JavaScript runs, so an app that was killed still shows the lock screen call screen. Every other phone gets a notification ring. A phone never gets both. The push expires with the invite, so a phone that comes back online does not ring for a call that died. At 45 seconds an unanswered invite becomes a quiet missed call notification. When Apple reports a VoIP token as dead, the server clears it and stops trying.

An answered ring is a grant: the person may join that huddle while it still runs, whether or not the room's key names them. The grant does not carry into the next huddle held in that room: the server cancels it when the room next starts from empty.

## The desktop call window

In the desktop app a running call can move to a window of its own, and it never opens as a browser popup. The microphone, camera and scribe state travel with the room. The first window stops hosting the media once the new one joins and does not leave the room, because both windows share one seat. The same window shows, in priority order: an incoming ring, a walkie burst, the call, and then the people wall or the floating faces when nothing is happening.

## Turning it on

Calls are a team feature, off until a team admin turns them on, under the same mechanism as [team chat](/documentation/team-chat). The deployment must also have LiveKit configured. When either is missing, the queries still answer and the clients hide every call control.
