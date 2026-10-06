A lot of engineering decisions are made on a call, and coding agents never hear them. Codecast huddles are built into the workspace (channels, DMs and each session's own room) and transcribe while they run, with the speaker's name on every line. When a huddle ends it gets a title, a summary and action items, and any agent can read it, quote the exact words, and turn what was agreed into tasks.

![A huddle in #payments, transcribing, with one audio lane each for Maya, Theo and Priya and a fourth lane for a session fed live. Below, the transcript with each line labelled cl-42:1 to cl-42:6 and the speaker's name, a huddle-chat reply from the Webhook retries session, and on the right the digest: Webhook retry rollout, 6 min huddle, with two action items linked to tasks ct-812 and ct-813.](/blog/field-manual/calls-hero.webp "The first minute of a six-minute huddle (fixture): one lane per voice, the session that heard it live, and the digest it left behind with each action item traced to its line.")

## Starting a huddle

The headphones button in a channel's header starts a huddle and buzzes everyone in it; in a DM it is push to talk. In a session, the same button starts a huddle with the agent, so one person is enough for a call. The phone can start or join one from any channel or session. **Expand the call** opens the stage with video, screen share and live captions under each speaker's name, and a **transcribing** pill shows whether words are being captured. Calls are a team feature an admin turns on in Settings.

## Every line knows who said it

Most meeting tools record one mixed stream and guess speakers afterwards. Codecast never mixes: one app in the room acts as scribe and sends each participant's own audio track to speech recognition separately, so attribution is structural rather than guessed. If the scribe's laptop closes, another participant's app takes over without writing a word twice.

## The digest lands where the huddle was held

A huddle in a channel or DM posts a digest there when it ends: "6 min huddle with Maya, Theo and Priya", a summary and the action items, with a link to the transcript. A huddle in a session's own room wakes that session's agent instead, with a short summary; the full transcript stays on the server until the agent asks for it, rather than flooding its context.

![Left, a #payments channel message: Maya's huddle digest with the title, length, speakers, a summary paragraph, two action items and a link to the transcript. Right, the session room: a huddle-summary block telling the agent it already heard the huddle live and where to read the rest, then agent woke, working, and the agent reading lines 3 to 4.](/blog/field-manual/calls-digest.webp "Same huddle, two destinations: a chat digest for people, a short wake-up for the session that was in the room.")

Every call also lives on the **Calls** page, live ones first. A call's page has the transcript, the summary ("So far" while it is live) and the action items; select a few turns to copy a link to them or **Send to agent**. A call has a short id like a task, and every line has its own reference. `cl-42` in a message renders as a pill with the call's title, and `cl-42:3-4` opens the call at those lines. So when an agent says "Theo agreed to take the retries", it links to the line where Theo said it.

## Action items become tasks that quote the call

The generated action items are a draft, so nothing files them blindly. Ask an agent to turn a call into tasks and it reads the summary, checks every item against the transcript (who committed, to what, by when, and whether anyone pushed back later), drops what was only floated and adds what the summary missed. Each surviving item becomes a task assigned to the person who took it on, with their words quoted in the description and marked as decided in a meeting, so it reaches the human task board on its own.

![Two rows, each in three steps: the generated action item, the transcript line it was checked against (Theo: Yes, I'll take it..., Priya: Then I'll write the customer note...), and the resulting task ct-812 or ct-813 marked from a meeting and assigned to that person.](/blog/field-manual/calls-tasks.webp "Each task is traced to the line where its owner said yes.")

## Agents on the call

**Add to the call** brings in a teammate, a role or an agent session, which then "hears the room and answers here". Words reach the agent each time the room goes quiet; a line that names it goes through at once, even mid-turn. When it needs to concentrate it can put the room on hold for up to half an hour and catch up after. It answers in the huddle's chat, and its face carries an **Agent** tag.

![Timeline of the room's speech blocks and the session's delivery markers: batches arrive whenever the room goes quiet; inside a dashed box labelled hold 10m, only a line that names the agent comes through, and the rest arrives together when the hold ends.](/blog/field-manual/calls-hold.webp "An agent on hold: the room keeps talking, the agent keeps working, and only a line that names it interrupts.")
![Huddle chat: Maya asks to split the 41 by customer, relayed to the session; the Webhook retries agent replies with a breakdown and an open session link; below, the agent's video tile labelled agent.](/blog/field-manual/calls-agents.webp "A session in the room answers in the huddle chat and appears with an agent label.")

![The codecast team chat from the product film: channels on the left, a #eng thread where a session titled Retry failed webhooks answers a teammate's question with a task card, and on the right an #eng huddle panel showing transcribing on, three participants, a note that Alex added the session so it hears the room and answers there, and Sarah's transcribed line.](/blog/field-manual/film-team.webp "From the homepage film's Team chapter: a channel, a session answering in it, and a transcribed huddle the session was added to.")

## Recording and screens

Recording is separate from transcription and never silent: only **Record this huddle** starts it, everyone (later joiners included) is told, a **REC** mark stays up, and it stops when no teammate is left. Screen shares are kept at full resolution, and an agent can pull the frame from the moment a line was said, so it sees the code that was on screen when someone said "this function here".

> **Why it matters.** Per-track transcription makes "who said it" a fact rather than a guess, and line-level references make it quotable. Together they let an agent act on a spoken decision and show its source: the task says who agreed, in their words, and links to the second they said it.
