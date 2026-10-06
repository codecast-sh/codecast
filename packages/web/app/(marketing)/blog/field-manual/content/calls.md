A lot of engineering decisions are made on a call, and coding agents never hear them. Someone types a summary later, or nobody does. Codecast huddles are built into the workspace (channels, DMs and each session's own room) and transcribe while they run, with the speaker's name on every line. When a huddle ends it gets a title, a summary and action items, and any agent can read it, quote the exact words, and turn what was agreed into tasks.

![A huddle in #payments, transcribing, with one audio lane each for Maya, Theo and Priya and a fourth lane for a session fed live. Below, the transcript with each line labelled cl-42:1 to cl-42:6 and the speaker's name, a huddle-chat reply from the Webhook retries session, and on the right the digest: Webhook retry rollout, 6 min huddle, with two action items linked to tasks ct-812 and ct-813.](/blog/field-manual/calls-hero.webp "The first minute of a six-minute huddle (fixture): one lane per voice, the session that heard it live, and the digest it left behind with each action item traced to its line.")

## Starting a huddle

In a channel, the headphones button in the header starts a huddle and buzzes everyone in it (a large channel asks first). In a DM it is push to talk, and a teammate's face card offers **Talk**, **Huddle** or **Message**. In a session, the same button starts a huddle with the agent: what you say reaches it as you speak, so one person is enough for a call. **Start Huddle** is also in the command palette, and the phone app can start or join one from any channel or session.

The call sits as a card among the faces in the header; **Expand the call** opens the full stage with video, screen share and live captions under each speaker's name. A **transcribing** pill shows whether words are being captured, and anyone can switch it off for everyone. Calls are a team feature: an admin turns them on under the team's Features in Settings.

## Every line knows who said it

Most meeting tools record one mixed stream and guess speakers afterwards. Codecast never mixes. One person's app in the room acts as the scribe, sending each participant's own audio track to speech recognition separately. A track belongs to one person, so attribution is structural and there is no guessing step to get wrong. If the scribe's laptop closes, another participant's app takes over the same run without writing a word twice.

## The digest lands where the huddle was held

A huddle in a channel or DM posts a digest there when it ends: "6 min huddle with Maya, Theo and Priya", a summary, and "Action items:" as a list, with links to the transcript and the call's page. A huddle in a session's own room wakes that session's agent instead, with a short summary and a pointer to the rest. The agent does not get the transcript dumped into its context; the words stay on the server until it asks for them. A huddle under 40 words gets no generated summary (its digest is the words themselves).

![Left, a #payments channel message: Maya's huddle digest with the title, length, speakers, a summary paragraph, two action items and a link to the transcript. Right, the session room: a huddle-summary block telling the agent it already heard the huddle live and where to read the rest, then agent woke, working, and the agent reading lines 3 to 4.](/blog/field-manual/calls-digest.webp "Same huddle, two destinations: a chat digest for people, a short wake-up for the session that was in the room.")

Every call also lives on the **Calls** page, live ones first, then history. A call's page has the transcript turn by turn, a collapsible summary (it reads "So far" while the call is still going) and its action items. Select a few turns and you can copy a link to them or **Send to agent**; the whole call can be sent the same way.

## Quoting the exact words

A call is an object with a short id, like a task or a session, and every transcript line has its own reference. `cl-42` in a message renders as a pill with the call's title; `cl-42:3-4` points at lines 3 and 4 and opens the call right there; `cl-42@12:34` points at a moment. So when an agent says "Theo agreed to take the retries", it links to the line where Theo said it, and anyone reading can check in one click.

## Action items become tasks that quote the call

The generated action items are a draft, so the app does not file them blindly. Ask an agent to turn a call into tasks and it reads the summary, checks every item against the transcript (who committed, to what, by when, and whether anyone pushed back later), drops what was only floated and adds what the summary missed. Each surviving item becomes a task assigned to the person who took it on, with their words quoted in the description and marked as decided in a meeting, so it reaches the human task board on its own.

![Two rows, each in three steps: the generated action item, the transcript line it was checked against (Theo: Yes, I'll take it..., Priya: Then I'll write the customer note...), and the resulting task ct-812 or ct-813 marked from a meeting and assigned to that person.](/blog/field-manual/calls-tasks.webp "Each task is traced to the line where its owner said yes.")

## Agents on the call

**Add to the call** brings in a teammate, a role or an agent session; the room's thread notes that it "hears the room and answers here". Words reach the agent each time the room goes quiet. A line that names the agent goes through at once, even mid-turn; the rest waits until its turn ends. When the agent needs to concentrate it can put the room on hold for up to half an hour, and everything said meanwhile arrives together when the hold ends. Its replies appear in the huddle's chat as its own lines, and its face in the room carries an **Agent** tag so nobody mistakes it for a person.

![Timeline of the room's speech blocks and the session's delivery markers: batches arrive whenever the room goes quiet; inside a dashed box labelled hold 10m, only a line that names the agent comes through, and the rest arrives together when the hold ends.](/blog/field-manual/calls-hold.webp "An agent on hold: the room keeps talking, the agent keeps working, and only a line that names it interrupts.")
![Huddle chat: Maya asks to split the 41 by customer, relayed to the session; the Webhook retries agent replies with a breakdown and an open session link; below, the agent's video tile labelled agent.](/blog/field-manual/calls-agents.webp "A session in the room answers in the huddle chat and appears with an agent label.")

![The codecast team chat from the product film: channels on the left, a #eng thread where a session titled Retry failed webhooks answers a teammate's question with a task card, and on the right an #eng huddle panel showing transcribing on, three participants, a note that Alex added the session so it hears the room and answers there, and Sarah's transcribed line.](/blog/field-manual/film-team.webp "From the homepage film's Team chapter: a channel, a session answering in it, and a transcribed huddle the session was added to.")

## Recording and screens

Recording is separate from transcription and never silent. Only a press of **Record this huddle** starts it, after a confirmation that everyone in the call sees it and anyone who joins later is told. A **REC** mark stays on screen, anyone in the call can stop it, and it stops on its own when no teammate is left. Screen shares are kept as their own full-resolution files, and an agent can pull the frame from the moment a given line was said, so it can see the code that was on screen when someone said "this function here".

> **Why it matters.** Per-track transcription makes "who said it" a fact rather than a guess, and line-level references make it quotable. Together they let an agent act on a spoken decision and show its source: the task says who agreed, in their words, and links to the second they said it.
