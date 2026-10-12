A Claude plan has usage windows: one that resets every five hours and one that resets weekly. When a window runs out, Claude Code stops in the middle of the work and waits for someone to type "continue" after the reset. On a computer running many sessions, one limit stops all of them, and they stay stopped until you come back.

Codecast treats a limit as a pause with a known end. The session is parked, and once you turn recovery on, it continues on its own: at the reset, or right away on another Claude account you've saved that still has room. You choose which, per computer. Recovery is off until you do. Agents also stop wrapping up early when a limit is near, so the room you have left gets used.

![A usage limit card in a conversation, and the same card once the session continued](/documentation/usage-limits/limit-card.webp "Top: the session window closed on the work account; the machine resumes at the reset, and the button would continue on the personal account now. Bottom: the same card once the session moved on.")

## Turn it on

1. Open **Agent features** from your account menu and pick the computer.
2. Switch on **Usage limits**, under *Hands on the machine*.

It turns itself on when a computer has more than one saved Claude account, because a limit is then only a short pause. The card's **How it works** shows what it changes.

![The Usage limits detail in Agent features](/documentation/usage-limits/limits-feature.webp "The Usage limits detail. Parked sessions resume at the reset, or move to a saved account with room.")

## Save more than one account

Open **Settings → Claude Accounts**. Each computer has its own section listing the Claude accounts saved on it, with how much of each window they have used and a **Switch** button.

Codecast saves every Claude account you sign in to automatically. To add one, sign in to that account in Claude Code on the computer (run `claude`, then `/login`); within about 30 seconds it appears on the page. If a **New login** row appears instead, give it a name and click **Save as profile**.

**Switch** moves the computer to that account. Sessions already running keep the account they started on until they restart.

## Choose whether codecast continues for you

At the top of each computer's section on the same page, **When a session stops on its own** sets one choice per computer. It covers every time codecast would type "continue" for you: after a usage limit, after an API or connection error, and after the agent crashed mid-turn.

![The four recovery choices on the Claude Accounts page](/documentation/usage-limits/recovery-mode.webp "One choice per computer. Changing accounts moves every session on that computer, because it runs one Claude login at a time.")

| Choice | What codecast does |
|--------|-----------|
| **Never continue for me** | Nothing. A stopped session waits until you continue it. This is the default |
| **Continue on this account** | Continues sessions after a limit resets, an error or a crash. Never changes accounts |
| **Continue, and ask before switching accounts** | The same, and on a limit it recommends the saved account with the most room and waits for you to approve |
| **Continue, and switch accounts automatically** | The same, and on a limit it moves the computer to the saved account with the most room and continues without asking |

An account that is out of room, or whose sign-in has expired, is never picked. When every saved account is spent, sessions wait for the earliest reset. When many sessions are parked, they come back a few at a time, so the restart itself doesn't look like a burst to Claude and trip another limit.

## What you see

- **In the conversation**, a **Usage limit** card names the window that closed, the account, and when it resets, then says what happens next ("Resumes on its own when the window resets", or a proposed switch). Its buttons approve a switch for this session, **Continue** once the window is open again, or open **Accounts**. While a session restarts, the card shows each step; afterwards it reads *Usage limit · resolved*.
- **Above the message box**, a line counts down: *Usage limit · resets in 2h 12m*.
- **In the inbox**, a parked session carries a **limit** badge, and when several are parked a banner sums them up ("3 sessions blocked on usage limits") with **Switch & continue** or **Continue**.
- **In the header**, the account chip shows the account in use, with a warning dot once a window passes 80%. Hover it for each account's **Session** and **Week** bars and the same choice of what happens on a limit; **Manage accounts** opens the settings page.

## Ask your agent

- "How much of my usage window is left, and when does it reset?"
- "Keep going through the night; if you hit a limit, pick it up after the reset."

With the feature on, an agent that gets Claude Code's "limit approaching" warning finishes its step and keeps working instead of stopping early.

## Codex

Codex accounts show in the header chip with their 5 hour and weekly windows, and a Codex session that hits its limit is parked and resumed the same way. Switching between Codex accounts isn't in the app yet.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| An account shows **login expired** | Click **sign in again** on its row |
| A session stays parked after the reset | Click **Continue** on its card, or check that the computer isn't set to **Do nothing** |
| A switch never happens | Save a second account, and set the computer to **Switch automatically** or approve the proposal on the card |
| The header says no Claude account is connected | Sign in to Claude Code on that computer |
