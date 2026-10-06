A lot of engineering decisions are made on a call, and coding agents never hear them. Someone types a summary later, or nobody does. Codecast huddles are built into the workspace (channels, DMs and each session's own room) and transcribe while they run, with the speaker's name on every line. When a huddle ends it gets a title, a summary and action items, and any session can read it with `cast call`, cite the exact words, and turn what was agreed into tasks.

![A huddle in #payments, transcribing, with one audio lane each for Maya, Theo and Priya and a fourth lane for a session fed live. Below, the transcript with each line labelled cl-42:1 to cl-42:6 and the speaker's name, a huddle-chat reply from the Webhook retries session, and on the right the digest: Webhook retry rollout, 6 min huddle, with two action items linked to tasks ct-812 and ct-813.](/blog/field-manual/calls-hero.webp "The first minute of a six-minute huddle (fixture): one lane per voice, the session that heard it live, and the digest it left behind with each action item traced to its line.")

## Every line knows who said it

Most meeting tools record one mixed stream and guess speakers afterwards. Codecast never mixes. One client in the room acts as the scribe: it holds each person's audio track and streams it to speech recognition on its own connection. A track belongs to one participant, so attribution is structural and there is no diarization step to get wrong. If the scribe's laptop closes, another client adopts the same run and the old one lets go, so no word lands twice. Each stored segment carries `seq`, `speaker_id`, `speaker_name`, text and times.

## The digest lands where the huddle was held

A huddle in a channel or DM posts a digest message there, transcript a click away. A huddle in a session's own room wakes that session's agent instead, with a short `<huddle-summary>` and the command to read the rest. The agent does not get the transcript dumped into its context; the words stay on the server until it asks. A huddle under 40 words gets no generated summary (its digest is the words themselves).

![Left, a #payments channel message: Maya's huddle digest with the title, length, speakers, a summary paragraph, two action items and Show transcript. Right, the session room: a huddle-summary block telling the agent it already heard the huddle live, with the command cast call cl-42 --transcript, then agent woke, working, and a terminal running cast call cl-42 3:4.](/blog/field-manual/calls-digest.webp "Same huddle, two destinations: a chat digest for people, a short wake-up for the session that was in the room.")

## Any session can read it, and cite the exact words

A call is an object with a short id, like a task or a session. Every transcript line prints with the reference that cites it, so an agent quoting the call names the line and the person. `cl-42` in a message renders as a live pill with the call's title, length and speakers; `cl-42:3-4` alone on a line embeds those lines with their speakers.

```terminal
$ cast calls
○ cl-42 14:02 6m  Webhook retry rollout
   Maya, Theo, Priya
○ cl-41 11:30 14m  Billing page review
   Maya, Sam
$ cast call cl-42 3:4
Webhook retry rollout lines 3-4
Priya
  cl-42:3 0:19 Can we move to exponential with jitter before Friday?
Theo
  cl-42:4 0:24 Yes, I'll take it. I'll add a dead letter queue while I'm in there.
Embed these words in a message: cl-42:3-4 on its own line
```

(Fixture output from the calls feature page; the real `cast calls` on this workspace lists teammates' calls, so it is not shown. `cast call <id> --transcript` prints the whole thing, `cast call cl-42@12:34` the lines being said at that moment, and `--json` the segments.)

## Action items become tasks that quote the call

The generated action items are a draft. The `/cast-from-call` skill reads the summary, checks every item against the transcript (who committed, to what, by when, and whether anyone pushed back later), drops what was only floated and adds what the summary missed. Each surviving item is filed with `cast task create --from-meeting`, assigned to the person who took it on, with their line quoted in the description. Tasks people agreed to on a call reach the human task board on their own.

![Two rows, each in three steps: the generated action item, the transcript line it was checked against (Theo: Yes, I'll take it..., Priya: Then I'll write the customer note...), and the resulting task ct-812 or ct-813 marked from a meeting and assigned to that person.](/blog/field-manual/calls-tasks.webp "Each task is traced to the line where its owner said yes.")

```terminal
$ cast task create "Exponential backoff with jitter for webhook retries" --from-meeting --assignee theo -p high -d - <<'DESC'
Agreed on the call Webhook retry rollout (cl-42).
Theo: "Yes, I'll take it. I'll add a dead letter queue while I'm in there."
Due: before Friday
DESC
ok Created ct-812: Exponential backoff with jitter for webhook retries
```

## Agents on the call

A huddle in a session's own room feeds that session live, so one person is enough to start a call: the agent is the second party. Any huddle can also be pointed at another session, a doc or a linked Slack channel. Words arrive each time the room goes quiet, on the same path as `cast send`. A line that names the agent goes through at once, even mid-turn; the rest waits until its turn ends. When the agent needs to concentrate it runs `cast call hold 10m` (up to 30 minutes per ask), and everything said meanwhile arrives together when the hold ends. The agent takes part in the huddle's text chat (its reply appears there as its own line, cut at 1800 characters with a link), and on codecast.sh it also gets a face: a video participant that speaks its replies and is marked as an agent on every surface.

![Timeline of the room's speech blocks and the session's delivery markers: batches arrive whenever the room goes quiet; inside a dashed box labelled cast call hold 10m, only a line that names the agent comes through, and the rest arrives together when the hold ends.](/blog/field-manual/calls-hold.webp "`cast call hold`: the room keeps talking, the agent keeps working, and only a line that names it interrupts.")
![Huddle chat: Maya asks to split the 41 by customer, relayed to the session; the Webhook retries agent replies with a breakdown and an open session link; below, the agent's video tile labelled agent.](/blog/field-manual/calls-agents.webp "A fed session answers in the huddle chat and appears as a labelled agent tile.")

![The codecast team chat from the product film: channels on the left, a #eng thread where a session titled Retry failed webhooks answers a teammate's question with a task card, and on the right an #eng huddle panel showing transcribing on, three participants, a note that Alex added the session so it hears the room and answers there, and Sarah's transcribed line.](/blog/field-manual/film-team.webp "From the homepage film's Team chapter: a channel, a session answering in it, and a transcribed huddle the session was added to.")

Recording is separate from transcription and never silent: only a press of Record starts it, everyone (guests included) is told, and it stops when no teammate is left. Screen shares are kept as their own full-resolution files, and `cast call snap cl-42:4` pulls the frame from the moment line 4 was said, so an agent can see the code that was on screen. Calls are a team feature, off until an admin turns them on, and need a LiveKit server for the media.

> **Why it matters.** Per-track transcription makes "who said it" a fact rather than a guess, and line-level citations make it quotable. Together they let an agent act on a spoken decision and show its source: the task says who agreed, in their words, and links to the second they said it.
