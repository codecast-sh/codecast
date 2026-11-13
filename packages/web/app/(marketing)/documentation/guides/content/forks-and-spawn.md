One conversation is often not the right size for the work. Your agent may want a second agent to review its change, three workers to audit three modules at once, or a fresh look from Codex. You may want to try two approaches from the same starting point and keep the one that works. Codecast gives you both: workers your agent starts and manages, and forks you start yourself.

The difference is who looks after the result. A worker reports to the session that started it, so your inbox shows one thread and its answer. A fork is a conversation of its own, in your inbox, for you to steer.

![A session that delegated two workers, linked them by name, and wrote one combined answer when both finished](/documentation/forks-and-spawn/workers.webp "A session that split a job between two workers and combined their results.")

## Turn it on

Open **Settings**, pick **Agent Features** under *Machines*, choose the computer your agents run on, and switch on **Forks & Sessions** under *Working together*. Your agents can then start workers on any agent you have installed (Claude Code, Codex, Cursor and others), fork when you ask, and hand work to a fresh session.

## Ask for workers

- "Have one worker review the diff and another write the missing tests, then tell me what they found."
- "Get Codex to review this change before I merge."
- "Audit each of the three payment modules in parallel and summarize the risks."
- "Reproduce the bug in the other repo while you keep working on the fix here."

The agent writes each worker a brief, starts it, and waits. A worker starts fresh and knows only its brief, so the agent gives it what it needs. While it waits, the parent is **dormant**. It wakes when its workers finish, get stuck, or need a permission, and workers that finish together reach it as one message. Then it reads their results and gives you one answer.

## Workers in the inbox

![The Acme inbox with a session and two worker rows nested under it, each showing its agent and state](/documentation/forks-and-spawn/inbox-nest.webp "Workers nested under the session that started them.")

- **Workers nest under their parent.** The parent shows its first two; **+N more sub-sessions** expands the rest and **collapse** folds them away.
- **Every worker is a full session.** Click one to read what it did, or write to it like any conversation.
- **States say who acts next.** **working** means the agent is producing, **dormant** means it waits on something that will wake it, **needs you** means a person has to act, and **done** means it delivered.

Your agent creates separate inbox threads only when you ask for them. Asking for something to run in parallel gets you workers, not a stack of new cards.

## Fork a conversation

A fork copies the conversation up to a point into a new session, which then goes its own way. Use it when the thread genuinely splits: two designs worth building, two theories about a bug, a risky refactor worth trying twice.

![A message's menu open with Fork from here highlighted](/documentation/forks-and-spawn/fork-from-message.webp "Forking from a message.")

- Hover a message and click the fork icon (*Fork from this message*), or pick **Fork from here** from its menu, or press `Alt` `F`.
- Write your next message and press `Cmd` `Shift` `Enter` (`Ctrl` `Shift` `Enter` off a Mac) to fork and send it in one step.

Or ask your agent: "Fork this two ways: try the queue, and try per endpoint limits." This thread continues on the first direction, and each other direction appears in your inbox as its own branch. A branch doesn't know it is a fork and reports to nobody; you steer it like any conversation.

```figure
ForkFigure
Each branch carries the conversation so far. The request to fork stays out, so no branch inherits it.
```

Press `T` or `Ctrl` `B` for the **Branch map**: every branch of the conversation, which one you are in, and **fork here** from any point.

![The branch map open over a conversation, showing the original thread and two branches with the current one highlighted](/documentation/forks-and-spawn/branch-map.webp "The branch map for a conversation with two forks.")

Opening a teammate's session works the same way. Its message box reads *Reply to fork this session...*, and replying gives you your own copy, leaving theirs untouched.

## Change the agent or the model

The agent and model chip in a session's header offers three ways to move a conversation:

![The session control menu with Switch agent, Fork as and Hand off to, each listing installed agents](/documentation/forks-and-spawn/move-menu.webp "Moving a session to another agent.")

| Choice | What it does |
|--------|--------------|
| **Switch agent** | Same session, another agent. The conversation continues under Codex (or another agent) with a divider marking the change |
| **Fork as** | A copy of this session on another agent, alongside the original |
| **Hand off to** | A fresh session, seeded with a brief of where the work stands |

**Change model & effort** in the command palette changes the model without changing the agent. To start something new yourself, click **New session** in the sidebar or press `Ctrl` `N`.

## On your phone

In the iPhone app, press and hold a message and pick **Fork from here**. The session's menu has **Fork as…** for another agent and **Fork tree** to see the branches.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| Workers show up as separate cards in your inbox | Ask the agent to start them as workers under its own session next time |
| The parent looks stuck while its workers run | It is **dormant**, waiting for them. It wakes when they finish |
| A worker is marked **needs you** | Open it. It may be asking a question or waiting on a permission prompt |
| You can't find a worker | Expand **+N more sub-sessions** under its parent |
