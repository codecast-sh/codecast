A new agent session usually knows only what you type into it. With Stable context on, it starts already knowing what you and your team have been working on: a short list of recent sessions, each with its title, who ran it, where it stands (working, waiting on someone, done) and how it began. So a fresh session notices that a teammate's agent is halfway through the same part of the code before it starts duplicating the work, and "pick up where we left off yesterday" just works.

The list is a set of pointers, not the conversations themselves. When one matters, the agent opens it and reads the details, the same way it looks things up with [Memory](/documentation/memory).

![The Context section of Agent features: the Stable context card with its Solo, Team and Off choice and the All projects switch, beside the Memory card](/documentation/memory/agent-features.webp "Stable context in Agent features. Pick Solo, Team or Off for each computer; All projects widens the list beyond the folder a session starts in.")

## Turn it on

1. Open **Agent features** from your account menu and pick the computer your agents run on.
2. Find **Stable context** under *Context* and pick how much it shares:
   - **Solo**: your 10 most recent sessions from the last 7 days.
   - **Team**: the team's 15 most recent sessions from the last 14 days.
   - **Off**: new sessions start without a list.
3. Switch on **All projects** if you want the list drawn from everything you work on, not just the folder the session starts in.

New sessions on that computer pick it up from then on. It works for Claude Code, Codex, Cursor, opencode and Grok sessions.

```figure
FeedWindowFigure
Solo keeps up to 10 sessions from the last week, Team up to 15 from the last two. A session you leave out gives its place to the next one.
```

## What you see

**When you start a session from the app**, the new session screen shows a **Context** line with the sessions it will start with. Open it to change the choice for just this session (**Auto** follows the computer's setting, or pick **Team**, **Solo** or **Off**), and click the **×** on any card to leave that session out.

**In a conversation**, a line at the top reads *Started with 15 session pointers from the team feed*. Click it to see the cards: exactly what the agent knew when it started, each one a link to that session.

![A conversation whose top shows the session cards it started with, above a new session screen previewing its cards with an Auto, Team, Solo, Off choice](/documentation/ambient-awareness/stable-context.webp "Top: the sessions a conversation started with, opened. Bottom: a new session's preview, where you can change the choice for this session or leave a card out.")

## What changes

- **Fewer "what were we doing?" openings.** Ask a fresh session "what was I working on yesterday?" and it already knows.
- **Less duplicated work.** An agent sees that another session is already working on the same thing and can read it first, or, with [Messaging](/documentation/messaging) on, ask it directly.
- **Sessions waiting on someone stand out.** The list marks which sessions are waiting for input, so an agent can tell you when work it depends on is stuck.

## Limits and privacy

- **Only sessions you can see.** Team mode lists teammates' sessions only when they are shared with the team; see [Team sessions](/documentation/team-sessions). Solo lists only yours.
- **It never holds a session up.** If the list can't be fetched (you're offline, say), the session starts without it.
- **It is a snapshot.** The list reflects the moment the session started. Later work by other sessions reaches it only if the agent looks.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| No *Started with* line at the top of new sessions | Check that Stable context isn't **Off** for the computer the session runs on |
| The list is missing a teammate's work | Switch to **Team**, and check that their folder is shared with the team |
| The list is full of unrelated projects | Switch **All projects** off so it sticks to the session's folder |
| One session keeps showing up and isn't relevant | Leave it out on the new session screen with its **×** |
