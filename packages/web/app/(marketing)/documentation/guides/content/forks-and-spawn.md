One conversation is often not the right size for the work. Your agent may want a second agent to review its change, three workers to audit three modules at once, or a fresh look from Codex. You may want to try two approaches from the same starting point and keep the one that works. Codecast gives you both: workers your agent starts and manages for you, and forks you start yourself.

The difference is who looks after the result. A worker reports to the session that started it, so your inbox shows one thread and its answer. A fork is a conversation of its own, in your inbox, for you to steer.

![A session that delegated two workers and summarized what they found](/documentation/forks-and-spawn/workers.webp "Asked to split a small research job between two workers. The session starts both and names them as live links, steps back while they run, and is woken when they finish (the two rows above its answer) to write one combined reply.")

## Turn it on

Open **Agent features** from your account menu, pick the computer your agents run on, and switch on **Forks & Sessions** under *Working together*. Your agents can then start workers on any agent you have installed (Claude Code, Codex, Cursor and others), fork when you ask, and hand work to a fresh session.

## Ask for workers in plain words

- "Have one worker review the diff and another write the missing tests, then tell me what they found."
- "Get Codex to review this change before I merge."
- "Audit each of the three payment modules in parallel and summarize the risks."
- "Reproduce the bug in the other repo while you keep working on the fix here."

The agent writes each worker a brief, starts it, and waits. Each worker starts fresh, knowing only its brief, so the agent gives it what it needs. While it waits, the parent is **dormant**. It wakes when its workers finish, get stuck, or need a permission, and workers that finish together reach it as one message. Then it reads their results and gives you one answer.

## What you see in the inbox

```figure
InboxNestFigure
Workers hang under the session that started them, each with its own agent and state.
```

- **Workers nest under their parent.** A worker row sits under the session that started it, with a ↳ arrow. The parent shows its first two; **+N more sub-sessions** expands the rest and **collapse** folds them away. The button at the top of the list hides or shows all subagent sessions at once.
- **Every worker is a full session.** Click it to read what it did, or write to it like any conversation. A card links back to the session that spawned it.
- **States say who acts next.** **working** means the agent is producing, **dormant** means it is waiting on something that will wake it, **needs input** means a person has to act, and **done** means it delivered.

Your agent creates separate inbox threads only when you ask for them, for work you want to steer yourself. Asking for something to run in parallel gets you workers, not a stack of new cards.

## Fork a conversation

A fork copies the conversation up to a point into a new session, which then goes its own way. Use it when the thread genuinely splits: two designs worth building, two theories about a bug, a risky refactor worth trying twice.

```figure
ForkFigure
Each branch carries the conversation so far. The request to fork stays out, so no branch inherits it.
```

You can fork yourself, from any message:

- Hover a message and click the fork icon (*Fork from this message*), or pick **Fork from here** from its menu, or press `Alt` `F`.
- Write your next message and press `Cmd` `Shift` `Enter` (`Ctrl` `Shift` `Enter` off a Mac) to fork and send it in one step.
- Press `T` or `Ctrl` `B` for the branch map: every branch of the conversation, which one you are in, and **fork here** from any point.

Or ask your agent: "Fork this two ways: try the queue, and try per endpoint limits." This thread continues on the first direction, and each other direction appears in your inbox as a branch with a **Fork** badge. A branch doesn't know it is a fork and reports to nobody; you steer it like any conversation.

Opening a teammate's session works the same way. Its message box reads *Reply to fork this session*, and replying gives you your own copy to continue, leaving theirs untouched.

## Change the agent or the model

The model chip in a session's header opens three ways to move a conversation:

| Choice | What it does |
|--------|--------------|
| **Switch agent** | Same session, another agent. The conversation continues under Codex (or another agent) with a divider marking the change |
| **Fork as** | A copy of this session on another agent, alongside the original |
| **Hand off to** | A fresh session, seeded with a brief of where the work stands |

**Change model & effort** in the command palette changes the model without changing the agent.

To start something new yourself, click **+** (*New session*) in the sidebar or press `Ctrl` `N`.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| Workers show up as separate cards in your inbox | Ask the agent to start them as workers under its own session next time |
| The parent looks stuck while its workers run | It is **dormant**, waiting for them. It wakes when they finish |
| A worker is marked **needs input** | Open it. It may be asking a question or waiting on a permission prompt |
| You can't find a worker | Expand **+N more sub-sessions** under its parent, or show subagent sessions with the button at the top of the list |
