A new agent session usually knows only what you type into it. With Stable context on, it starts with a short list of what you and your team have been working on: recent sessions, each with its title, who ran it, where it stands (working, waiting on someone, done) and how it began. A fresh session can see that a teammate's agent is halfway through the same part of the code before it duplicates the work, and "pick up where we left off yesterday" works without explanation.

The list holds pointers to sessions, not the conversations themselves. When one matters, the agent opens it and reads the details, the same way it looks things up with [Memory](/documentation/memory).

![A conversation whose top line reads "Started with 15 session pointers from the team feed", opened to a row of session cards](/documentation/ambient-awareness/stable-context.webp "The sessions a conversation started with. Each card opens that session.")

## Turn it on

1. Open **Settings** (**⌘,**), then **Agent Features** under *Machines*, and pick the computer your agents run on.
2. On the **Stable context** card under *Context*, pick how much it shares:
   - **Solo**: your 10 most recent sessions from the last 7 days.
   - **Team**: the team's 15 most recent sessions from the last 14 days.
   - **Off**: new sessions start without a list.
3. Switch on **All projects** to draw the list from everything you work on, not only the folder the session starts in.

![The Context section of Agent Features: the Stable context card with Solo, Team and Off and the All projects switch, beside the Memory card](/documentation/memory/agent-features.webp "Stable context sits under Context, beside Memory.")

New sessions on that computer use the setting from then on. It works for Claude Code, Codex, Cursor, opencode and Grok sessions.

```figure
FeedWindowFigure
Solo keeps up to 10 sessions from the last week, Team up to 15 from the last two. A session you leave out gives its place to the next one.
```

## Change it for one session

When you start a session from the app, the new session screen shows a **Context** line with the choice and how many sessions it will start with. Click it to see the cards. Pick **Auto** to follow the computer's setting, or **Team**, **Solo** or **Off** for this session only, and click the **×** on a card to leave that session out.

![The new session screen with its Context line opened: an Auto, Team, Solo, Off choice above a row of session cards, each with an ×](/documentation/ambient-awareness/new-session-context.webp "The new session preview. Change the choice or drop a card before the session starts.")

On the iPhone, the new session sheet has the same choice in its **Context** row.

![The phone's new session sheet with its Context row](/documentation/ambient-awareness/phone-new-session.webp "On the phone, tap Context to pick Auto, Team, Solo or Off.")

## See what a session started with

At the top of a conversation, a line reads *Started with 15 session pointers from the team feed*. Click it to open the cards: exactly what the agent knew when it began, each a link to that session. Sessions started with Stable context off have no line.

## What changes

- **Fewer "what were we doing?" openings.** Ask a fresh session what you worked on yesterday and it already knows.
- **Less duplicated work.** An agent sees that another session is on the same thing and can read it first, or, with [Messaging](/documentation/messaging) on, ask it directly.
- **Stuck work stands out.** The list marks sessions waiting for input, so an agent can tell you when work it depends on is stalled.

## Limits and privacy

- **Only sessions you can see.** Team lists a teammate's sessions only when they are shared with the team; see [Team sessions](/documentation/team-sessions). Solo lists only yours.
- **It never holds a session up.** If the list can't be fetched (you're offline, say), the session starts without it.
- **It is a snapshot** of the moment the session started. Later work by other sessions reaches it only if the agent looks.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| No *Started with* line on new sessions | Check that Stable context isn't **Off** for the computer the session runs on |
| A teammate's work is missing | Pick **Team**, and check that their folder is shared with the team |
| The list is full of unrelated projects | Switch **All projects** off so it sticks to the session's folder |
| One irrelevant session keeps showing up | Leave it out with its **×** on the new session screen |
