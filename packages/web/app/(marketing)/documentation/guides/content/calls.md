A call is the one team artifact an agent could not read. Code is in the repository, tasks are on the board, chat is searchable, and every session leaves a transcript. A decision made out loud leaves nothing behind. A task that says "as we discussed on the call" then points at something no agent can open, so the agent guesses or asks again.

Codecast calls close that gap with a transcript that names its speakers. Every huddle transcribes while it runs, and each line carries the person who said it. When the huddle ends it gets a title, a summary and a list of action items. `cast calls` lets a session read all of it without having been in the room, so "what we discussed on the call" becomes a line an agent can quote with the speaker's name on it.

Codecast owns everything except the media. Rooms, rings, authorization and access tokens live in Convex, and audio and video flow between the clients and a LiveKit server. The calls [snippet](/documentation/agent-snippets) teaches agents the commands below.

```bash
cast calls                        # calls across your teams, live ones first (-n 50 for more)
cast call <id>                    # one call: title, participants, summary, action items
cast call <id> --transcript       # the full transcript, a speaker on every line
cast call <id> 15:25              # just lines 15 to 25
cast call <id> --json             # the same as data; always includes the segments
cast call snap cl-42:15           # a frame of the recorded call when line 15 was said
```

`<id>` is a call's short id (`cl-42`) from `cast calls`, its full id, or a unique prefix of one.

A call is a referenceable object like a task or a session. `cl-42` written in a message renders as a live pill with the call's title, length and speakers. Add a range of the line numbers the transcript prints and it names the words themselves: `cl-42:15-25` on its own line embeds those lines with their speakers, and inline it reads as a pill that shows them on hover. Either form links to the call page with those lines selected. A segment in the JSON carries `seq`, `speaker_id`, `speaker_name`, `text`, and its start and end times. You can read a call you took part in, and a call whose room you may enter. A recording of one person's microphone shows in the same list, and it belongs to its creator until they share it with a team.

## Rooms and presence

Starting a huddle from a channel buzzes every other member: the whole team for a public channel, or that channel's members for a private channel. Channels with more than seven people ask for confirmation first. Joining an existing huddle does not buzz the channel again. Busy and quiet-hours settings still apply.

A room is a string key and never a stored row, so every client derives the same key without coordination.

| Key | What it is | Who the key admits |
|-----|------------|--------------------|
| `dm:<id>:<id>` | A set of 2 to 9 people, ids sorted. A DM and the huddle of its members are the same room | The people it names |
| `channel:<channelId>` | A chat channel's standing room | Whoever may access the channel |
| `session:<convId>` | A huddle about one session | The session's owner, and teammates when the session is visible to the team |

A seat is a lease. A client in a room sends a heartbeat every 15 seconds, and every reader ignores a seat older than 45 seconds, so a closed laptop leaves the room without a cleanup step. A person joins muted, and unmuting is the deliberate act. An occupied room admits any member of its team, the way a meeting room with people in it admits whoever walks up. A channel room is the exception and keeps the channel's own membership. A huddle that wants privacy locks the room. A teammate can knock at a locked room, and anyone inside admits them by ringing them in. A person from outside the team comes in only as a guest, on a link, and only when somebody inside lets them in (see Guests below). The server checks these rules in every call mutation and when it mints a media token, because the media server trusts that token.

Presence comes from two facts about a person's machine: how recently the app checked in, and how recently somebody touched the keyboard or mouse. A person reads as active when the app checked in within 150 seconds and there was input within 3 minutes. The states are active, idle, away and offline. A person can declare busy or away, and a declaration wins over what the machine reports. The people wall draws the whole team at once and sizes each face by how present the person is. Click a face and three labeled actions appear under it: Talk, Ring and Message.

## Guests

A huddle can include people from outside the team. Press **invite** beside the lock on the call stage, **Invite guest** on a live call's page, or **Guest** beside the huddle button in a channel or session header to send a link before the meeting starts, and copy the link. It stays open for seven days unless you pick one hour, one day or thirty days. **replace** swaps it for a new one with the length you picked, and **turn off** closes it. Pressing invite again copies the same link instead of making a second one. The panel says what guests will see the call called: a channel by its name, anything else as a call with whoever invited them, since a session's title is the team's own label. Only people who may invite into the room see these controls.

The guest opens the link in a browser, with no account and nothing to install. Before they ask to join they see which meeting it is, who invited them, their own camera and microphone with a choice of devices, and a plain notice when the call is transcribed or recorded. Asking to join is their agreement to that notice. They wait at the door until somebody inside lets them in, and if nobody is in the room yet, whoever made the link gets a push on their phone that they are waiting (the guest's page says so only when that push went out). If the room starts recording while they wait, the door says so, and they walk in only when they press Join.

Their knock appears at the door beside a teammate's, marked as a guest, with **Admit** and **Deny**. When the call stage is closed it also arrives as a notification with the same two answers, which stays until the knock is answered, and as a system notification when the app is in the background. On a phone, the call screen shows the guest at the door with the same answers. A guest who was turned away can ask again after a minute, and when a link keeps bringing people the room turned away, the door offers to deny and turn the link off in one press.

Inside, a guest is marked as a guest on every face, tile and transcript line, so a typed name never passes for a teammate's. They can talk, show their camera and share their screen. They see the call and nothing else: not the team, its sessions, the thread or the transcript. Anyone inside can remove a guest from beside their name or from their face in the header, and they are disconnected at once. An agent in the room treats what a guest says as conversation rather than instructions.

An admission lasts for one huddle. When the last teammate leaves, the guests are let go with them, so a link from Tuesday's meeting cannot open Wednesday's on its own. A guest whose page goes quiet and who has dropped out of the call is let go too; a phone guest who switches apps for a minute stays in, because the media server still has them. A guest who reloads the page is still let in, and rejoins with one press. A guest who loses the connection and reconnects comes back with their microphone and camera as they left them.

## Transcription with exact speakers

Attribution is structural and never inferred. One client in the room is the scribe. It holds every audio track in the room, which is its own microphone plus each remote track, and it streams each track to speech recognition on its own connection. A track belongs to one participant, so each segment is stamped with that participant. The server stores the segments and mints the short lived recognition credentials.

Every huddle transcribes unless somebody inside says otherwise. A client starts a run when it joined on purpose and the room has two or more people, and the server decides which client is the scribe. If the scribe's seat lapses, another client adopts the same run, and the old one lets go so no word lands twice.

Transcription is a switch the room owns. It is a field on the room's state row, and anyone seated may flip it either way. It has to live on the room: a flag held by one client would be overruled by the next client that looked. Turning it off ends the run wherever it lives, and the digest of what was already said still posts.

## Video and frames

A huddle can also be recorded as video. Recording starts only when someone in the room presses Record, everyone in the room is told, including anyone who joins later and any guest, and anyone in the call can stop it, guests included. It stops by itself when the huddle ends. The recording runs on the LiveKit server, not in anyone's browser, so it does not depend on whose tab stayed open. Each run keeps two kinds of file: the room as people saw it, with every face, the screen share and everyone's audio, and each screen share on its own at full resolution, where text on the shared screen stays legible. The files live in a private bucket. Whoever may open the room's calls can watch the video: the people a huddle is between, everyone in a channel, everyone who can open a session. A reader gets a link that lasts minutes, minted after the same access check as the call itself.

On the call page the video plays above the thread and stays in step with it. Click a line to see that moment, hold Shift and click to select lines to send, and the line being said lights up as it plays, with the thread following it until you scroll away to read something else (Back to the moment brings it back). When someone shared a screen, switch the view to that screen at full size and the room's sound keeps playing underneath. A link with `?t=754` opens the page paused at that second. Copy moment puts `cl-42@12:34` on the clipboard, and the thread's lines for a recording starting or stopping jump to that moment of the video. A call recorded twice plays on from one recording into the next. Whoever pressed Record, or an admin of the team, can delete a recording, and the thread says who did. A public share link shows the video only when someone turns on "Includes the video recording" for that link, and then only the room's view, never a single person's screen file.

A recorded call answers "what was on screen when they said that". `cast calls` marks the calls that have video, `cast call cl-42` lists the stretches that were filmed, and `cast call snap` turns a call reference into a picture an agent can open:

```bash
cast call snap cl-42:15           # the moment line 15 was said (cast call snap cl-42 15 works too)
cast call snap cl-42@12:34        # 12 minutes 34 seconds into the call (also 754s, 1:02:03)
cast call snap cl-42:15-25        # frames across lines 15 to 25
cast call snap cl-42              # the call as it is right now, while it records
cast call cl-42@12:34             # the words around that moment, without the picture
```

Each frame is written as a PNG and printed with what it shows, the line being said at that moment and its citation. A line's frame is taken a beat after its first word, on a whole second, so the citation names the exact frame the agent saw. A line that began a moment before Record was pressed is shown from its first recorded second, and the output says so. Across a line range, a screen share yields a frame each time the screen changed, and the stretches with no share yield evenly spaced frames of the room, eight in all unless `--max` says otherwise (up to 50).

A frame shows the shared screen from its own full resolution file whenever one covers the moment, and the room otherwise. `--composite` asks for the room view regardless. `--screen` asks for the shared screen only, and refuses a moment no share covers, naming the screens that were recorded. `-o` takes a .png or .jpg file, or a directory. Without it, frames go to a private scratch directory that is cleared after a day, because a frame of a private call is as private as the call. `--json` prints the same as data, refusals included (`{"error", "code"}`), and each frame carries its `kind` and what it `shows`.

The moment comes from the shared clock: a transcript line carries its time since the call started, each file knows the wall clock of its first frame, and one function maps a moment to the file and offset that show it. The command and a frame embedded in a message use that function with the same choice of view, so a citation renders as the very picture the agent read. The call page's player uses it too, starting from the room's view because that is the file with everyone's sound. The seek itself runs on your machine with ffmpeg: a single frame reads a couple of megabytes around that moment, and a range on a shared screen reads the stretch once to find where it changed (a stretch too long to read is sampled evenly, and the output says so). ffmpeg reads through a short-lived proxy on your own machine, so the signed link never appears on a command line and is signed again when it is about to lapse. The command needs `ffmpeg` installed and says how to install it when it is missing.

`cl-42@12:34` written in a message renders as that frame of the call, linked to the call page at that time (`?t=754`), for anyone who may read the call. `--share` is different: it uploads each frame as an image anyone with its link can open, for readers outside the team. LiveKit uploads a recording's video when Record is stopped or the huddle ends, so while a call is still recording only its live picture (`cast call snap cl-42`) can be snapped. When a snap cannot give a picture it says why and what to try: the call was not recorded, the moment falls outside what was recorded (with the recorded stretches and the nearest moment that works), or the recording is still being made.

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
