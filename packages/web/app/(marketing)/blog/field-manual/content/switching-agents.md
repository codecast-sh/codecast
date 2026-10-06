Every coding agent keeps its own transcript in its own format: Claude Code writes JSONL under `~/.claude/projects`, Codex writes rollout files, Grok keeps a `chat_history.jsonl`, OpenCode keeps a SQLite store, pi keeps a session JSONL with a parent chain. Normally that means a conversation is stuck with the agent that started it. If Claude has spent two hours on a bug and you want Codex to take a look, you copy and paste.

Codecast doesn't have that problem, because the conversation already lives on its server. The server holds one neutral copy of every message: user turns, assistant turns, tool calls and tool results. Each agent's native transcript is just one rendering of that copy. To move a conversation to another agent, codecast writes the history out in the target agent's own format and starts that agent on it.

On top of that one mechanism sit seven ways to move work: an in-place switch, a fork onto another agent, a handoff with a brief, a worker on another backend, a one-shot `exec`, an automatic hop to another account when one hits a usage limit, and a migration to another machine.

![A conversation drawn as a tree: a fork that carries the history, Codex and Gemini workers spawned with cast spawn --subagent that report back, then cast switch --agent codex recolors the trunk with a 'now using Codex' marker and Codex continues](/blog/field-manual/switch-treehero.webp "The /features/agents hero draws one conversation as a tree. Forks carry the history (solid lines). Workers on Codex and Gemini start fresh and report back (dashed lines). At the bottom, `cast switch --agent codex` changes the trunk's color in place: same thread, new agent.")

## Which backends exist

The registry in `packages/shared/contracts/agentClients.ts` lists eight local agents: **Claude** (Claude Code), **Codex**, **Cursor**, **OpenCode**, **pi**, **Grok** (Grok Build), **Muse Spark** and **Gemini**. For every agent the registry records what codecast can actually do with it. One flag decides whether a conversation that already has history can move into that agent: `capabilities.reconstitute`, meaning "codecast knows how to write this client's transcript from the server copy". Six of the eight have it. Cursor and Muse don't. For those two, the web picker labels the row "can't rebuild history", and the server refuses before it touches the row:

```terminal
Cursor cannot take over an existing session's history; start a new Cursor session instead
```

The refusal comes first so that the row's `agent_type` never names an agent the daemon then fails to launch. A blank session (no messages yet) is just relaunched, so it can become any agent.

## 1. `cast switch`: same conversation, another agent or model

```terminal
$ cast switch --help
Usage: cast switch [options]

Change the agent or model on this session without forking

Stays on the same conversation. A divider lands in the thread
("now using Codex"). A provider switch replaces this process.

Examples:
  cast switch --agent codex
  cast switch --model opus
  cast switch --agent claude --model sonnet
  cast switch --agent codex --fork     # optional: a new session instead

Options:
  --agent <name>      Agent to continue as (claude, codex, cursor, opencode,
                      pi, grok, muse, gemini)
  --model <name>      Model option key (opus, sonnet, gpt-5.4, …)
  --effort <level>    Effort level (low, medium, high, max, …)
  -s, --session <id>  Session to switch (default: the current one)
  --fork              Create a new session instead of continuing here
  --json              Machine-readable output
```

The conversation id doesn't change. The inbox card, the links, the bound task and the share URL all stay where they were. Under the hood, the server mutation `switchSessionAgent` takes one of three paths:

- **Same provider, new model or effort, live session.** No restart. The server updates the row and queues `/model sonnet` or `/effort high` as messages to the running agent, the same way you would type them. The echo of that slash command is drawn as the divider.
- **Different provider (or a model change the agent can't apply mid-session).** The server inserts a divider message into the thread, `[codecast] Now using Codex (was Claude · Fable).`, and then queues a kill-and-resume for the daemon on the machine that owns the session. A provider switch replaces the agent process.
- **Blank session.** Nothing to rebuild, so it is simply relaunched as the new agent.

The interesting part happens on the daemon. For a cross-agent switch it:

1. Tears down the old backend *with a turn interrupt*. Dropping the bookkeeping alone wasn't enough: a Codex app-server thread kept running, and its output kept landing on the conversation.
2. Pages the whole conversation down from the server's `/cli/export` endpoint, 500 messages at a time.
3. Writes it out in the target's native format, with a generator for each agent in `jsonlGenerator.ts`:  **Claude**: a Claude Code JSONL with a proper `parentUuid` chain, where each tool result is matched to the `tool_use` that asked for it. **Codex**: a rollout with `session_meta`, `function_call` and `function_call_output` items, imported through the Codex app-server's `thread/fork` so Codex mints a real thread id. **Grok**: `chat_history.jsonl` plus `summary.json`, which `grok --resume` loads. **pi**: its session JSONL with header and parent chain, for `pi --session`. **OpenCode**: no import endpoint exists, so the daemon creates a session through the `opencode serve` sidecar and appends the whole history as one `noReply` user message. **Gemini**: goes through the Claude JSONL writer and `gemini --resume latest`. The registry calls this "a sanctioned oddity".
4. Rebinds the conversation to the new native session id and resumes it. It also clears delivery state, so a message that was queued for the old agent is delivered again to the new one.

Long histories get trimmed to fit the target's context window. Above an estimated 180k tokens, a Claude rebuild keeps the tail of the conversation (about 160k tokens' worth) plus *every earlier human instruction*. It also adds a hidden note at the top that says how many messages were left out and gives the exact `cast read` range to fetch them. Codex imports cap at 4,096 items or 240 KB. Past that, oversized items are clipped in the middle with a pointer back to the transcript. Nothing is lost for good: the server copy stays whole, and the agent is told how to read it.

![A conversation: the user asks 'Reply with only the word PONG', Claude answers PONG, a divider reads 'now using OpenCode was Claude · Fable', another session asks 'What word did you reply with earlier?', and OpenCode answers PONG](/blog/field-manual/switch-live-divider-thread.webp "A switch, as the app draws it. Claude answers PONG. The divider marks the move to OpenCode. When another session asks what it said earlier, OpenCode answers PONG from the imported history, even though it never saw the first turn.")

The divider is an ordinary message stored with `subtype: "agent_switch"`. The web and mobile timelines draw it as a rule that reads "now using OpenCode · was Claude · Fable". It also stays in the history the next agent is given, so the new agent knows a switch happened. The body ends: "This session continues here. History above is the same thread."

![The /features/agents switch section: a terminal listing cast switch commands next to a mock thread where Claude reports, the user asks for a second pair of eyes, cast switch --agent codex runs, a 'now using Codex' divider appears and Codex adds jitter](/blog/field-manual/switch-section-mock.webp "The feature page's switch section. The usual reason to switch is a second opinion from a different model on the same evidence.")
![The /features/agents chooser with 'Keep going on another agent or model' selected: cast switch --agent codex; starts with the same conversation, the id does not change; shows up in the same thread with a 'now using Codex' divider; hears back: you, exactly as before](/blog/field-manual/switch-chooser.webp "The page's chooser, with &quot;Keep going on another agent or model&quot; selected. Each way of starting or moving an agent is described by what it starts with, where it shows up, and who hears back.")

> **Why it matters.** The switch carries the *conversation*, not the first agent's internal state. Tool calls and their results are carried over as data, translated into the target's own tool-call shape. Hidden reasoning and the old agent's prompt cache are not. In practice this is what you want for a second opinion: the new model reads the same evidence and reaches its own conclusions.

## In the app: the session control

The same moves are available in the conversation header. The model label next to the agent icon opens a panel. It shows the current agent and model with a line of state ("Live session · picks apply in place", or "Blank session · picks apply at launch"), the model and effort pickers, and a section called **Move this session** with three rows:

- **Switch agent**: "Same session, another agent"
- **Fork as**: "A copy of this session on another agent"
- **Hand off to**: "A fresh session, seeded with a brief"

Each row opens a list of agents. Agents that can't take over history are labeled "can't rebuild history", using the same `canSessionBecomeAgent` check the server enforces. The command palette offers the same verbs: "Switch agent…", "Fork session as…", "Hand off to…" and "Change model & effort…". Picks render optimistically: a fork shows up as a stub row marked "copying" before the server answers.

## 2. Fork onto another agent: `cast switch --agent codex --fork`

A fork creates a new conversation and keeps the original running. `cast fork` itself branches on the same agent. Its help documents `--at`, `--tip`, `--all-branches` and `--cloud`, but no `--agent`. A fork onto a different agent is `cast switch --agent <x> --fork`, which posts to `/cli/fork` with a target agent type. It is also the "Fork as" row in the app.

The server copies the messages into the new conversation in batches (up to 500 documents or 8 MB each) and only then tells the daemon to start it. The daemon builds the target's transcript the same way an in-place switch does. Agents that have a native fork take a cheaper path at the tip of the conversation. Grok, for example, uses `--resume <parent> --fork-session`, a byte-exact copy that keeps the prompt cache warm. A fork from the middle of a conversation always goes through the rebuild, because a native copy can't be cut at an earlier message.

## 3. `cast handoff --to codex`: keep the conclusions, drop the noise

```terminal
$ cast handoff --help
Usage: cast handoff [options]

Hand this session's work to a new session on another agent or model, or
generate a context transfer document

With --to (or --model), the server writes a brief of the source session
(goal, decisions, what is verified, open questions, ordered next steps),
composes the new session's first prompt from it, starts the session in the
same directory as a first-class inbox card, links both rows, binds it to
the source's task or plan, and pins the source's state as done. The source
agent ends its turn after this command.
  ...
  --to <agent>          Agent for the new session: claude, codex, cursor,
                        opencode, pi, grok, muse, gemini, or same (the source's
                        own)
  --model <model>       Model for the new session (e.g. opus, sonnet); --model
                        alone keeps the source's agent
  --account <name>      Claude account profile the new session runs on
  --device <name>       Machine to start the new session on (label or device id)
  -m, --message <text>  Direction for the new session, appended to the composed
                        prompt; '-' reads it from stdin (heredoc-friendly)
  --dry-run             Compose and print the new session's prompt without
                        starting anything
```

A switch keeps every message. A handoff keeps only the conclusions. One server action (`convex/handoff.ts`) does it all. It reads the source session's facts, its pinned state, and the first 8 plus last 40 readable turns. It asks a small model for a brief of under 500 words that names exact files, commands and ids. It composes the first prompt and creates the new session already linked, bound to the same task or plan, with the source pinned as "Handed off to <id> on <agent>". If the model call fails, a fallback brief is built from the pinned state and the last assistant message, and the response reports it with `brief_source`. Because the new agent starts from a prompt, not a rebuilt transcript, a handoff can target any agent, including Cursor and Muse.

Here is a dry run on the session that wrote this section. It starts nothing:

```terminal
$ cast handoff --to codex --dry-run -m "finish the comparison table"
# Handed off from jx731jg: Switching agents midstream

Ran on Claude (claude-opus-5-5).

This session continues that work. Read the brief below, then pick up at the
first next step. The transcript is one command away when the brief is not enough.

## Brief

## Goal
Write `sections/03-switch.html` (slug `switch`) covering all ways to move
conversations between agent types and models without losing context, ...

## Decisions
- Use `cast handoff --dry-run` on the current session to generate a real
  composed prompt for the article ...

## Verified
- Fanout shot from the film (hero-t 18, Cursor and Codex workers under one
  lead) exists and has been copied.
  ...

## Next steps
1. Grep packages/cli/src for all agent/backend definitions ...
  ...

## Read more

The source transcript has 106 messages. Read it in windows, not whole:

cast read jx731jg 1:20   # the opening: goal and first decisions
cast read jx731jg 87:106   # the tail: latest work
cast diff jx731jg   # files changed, commits, tools used

## Direction

finish the comparison table
dry run: nothing started; brief model-written
```

![The /features/agents handoff section: a brief with Goal, Decisions, Verified, Open questions and Next steps, a footer showing source done arrow codex new session linked same task, and a terminal with cast handoff examples](/blog/field-manual/switch-handoff-mock.webp "The feature page's handoff mock. The footer is the whole contract: the source session is marked done, the new Codex session is linked and bound to the same task.")

## 4. Workers on another backend: `cast spawn --subagent --agent codex`

Sometimes you don't want to move the conversation at all. You want a different agent to do one piece of it. `cast spawn --subagent --agent codex "review the diff"` starts a fresh Codex session nested under yours. It is out of the inbox, and your session is woken when it finishes, blocks or waits on a permission. `--agent` on spawn accepts claude, codex, cursor, gemini, opencode, pi and grok. Workers start with no shared history, only the brief you write. So Cursor, which can't take over a history, works fine here.

![Two worker sessions side by side under one lead: 'Dashboard retry UI' running on Cursor composer-2 and 'Webhook API half' running on Codex gpt-5.5-codex, both working on parts of a webhook retry feature](/blog/field-manual/switch-fanout.webp "The homepage film's fan-out chapter (`?hero-t=18`). One lead split the webhook-retry work into a Cursor worker for the dashboard and a Codex worker for the API. Both are full sessions in the same inbox, each on its own backend and model.")

## 5. One answer from another model: `cast exec --agent grok`

`cast exec` is print mode for every harness: run a prompt, print the result, exit. There is no inbox card, and the exit code is the agent's own. It maps one set of flags onto each client's own headless form, which `--dry-run` shows:

```terminal
$ cast exec --dry-run --agent codex "review the diff"
codex exec --dangerously-bypass-approvals-and-sandbox 'review the diff'

$ cast exec --dry-run --agent grok --model grok-4.6 "review the diff"
grok --permission-mode bypassPermissions -m grok-4.6 -p 'review the diff'

$ git diff | cast exec --agent claude --model sonnet "write a commit message"
```

It is the cheapest way to ask another model something without moving anything. `--resume <id>` continues an earlier run, `-j` runs prompts in parallel, and `--chain` pipes one step's output into the next.

## 6. Switching accounts midstream: usage limits

A usage limit is the most common reason a session stops, and codecast treats it as a switch too: same agent, same conversation, different account. `cast accounts save <name>` snapshots each Claude Code login once. After that, what happens on a limit is a policy (ask, auto, resume or off) that the server applies:

```terminal
$ cast usage
work  as of 1m ago
  Session (5h)   57%  resets in 4h 5m
  Week (7d)      34%  resets in 7d
  Fable (7d)     11%  resets in 7d
On a limit: auto-switch hops to the freshest of 10 saved account(s) with headroom (best: personal at 25%) and continues parked sessions.
```

- **Resume at reset** (on by default): a session parked on a limit gets a "continue" on the same account once its window rolls over.
- **Auto-switch** (opt-in): the server picks the cheapest fix. It continues on the same account if the window has already reset, otherwise moves to the saved profile with the most headroom, otherwise waits for the earliest reset.
- **The fleet store.** On a laptop, every session codecast launches reads its login from one credential store that the daemon owns, and Claude Code re-reads that store about every 30 seconds. A switch rewrites it, and every running session moves to the new account within half a minute, *mid-turn and with no restart*. Machines using the fleet store also **switch ahead**: they leave an account at 95% of its 5-hour window or 97% of its weekly window, before anything gets parked.
- **Workers follow their parent.** A Claude subagent runs inside its parent's process, so when a worker gets parked, the parent receives the "continue".

Codex has saved profiles, but switching Codex accounts doesn't exist yet. A Codex session recovers only by continuing after its window resets, or by spending a reset credit if the device allows it.

## 7. Switching machines midstream: `cast migrate`

`cast migrate start --to linux --label rollout` moves a batch of sessions between a laptop and a cloud host, in either direction. A mid-turn session is first fenced, and the move waits for its turn to finish (`--wait`, default 10 minutes, after which the turn is interrupted). Messages sent during the move are held as pending. Ownership changes, the session resumes on the destination and the fence lifts in a single transaction, so the held messages belong to the destination the moment it owns the row. The agent is then told where it is, with a notice that begins:

```terminal
[codecast] This session just moved to a different machine. It now runs on
<dest> in <cwd> (previously <old>). ... Processes, ports, and any files
outside the working tree from the previous machine are not here.
```

On the destination the conversation is rebuilt from the server copy, just as in a switch, because the destination never ran it. A session stopped at a permission prompt moves immediately, and the prompt is asked again on the other side.

## Which one to use

| Method | Keeps conversation id? | New process? | History the new agent gets | When to use |
|---|---|---|---|---|
| `cast switch --model sonnet` (same provider) | Yes | No: `/model` is sent to the live agent | All of it, untouched | Cheaper or stronger model for the next step |
| `cast switch --agent codex` | Yes | Yes: old agent killed, new one resumed on a rebuilt transcript | Full thread, trimmed only to fit the context window | Second opinion, or a backend that is better at the next step |
| `cast switch --agent codex --fork` / "Fork as" | No: new conversation, original keeps running | Yes, a second one | Copy up to the fork point | Try another agent without giving up the original |
| `cast fork "a" "b"` | This thread takes the first direction; branches are new | Yes, one per branch | Copy up to just before your request | Same agent, several directions in parallel |
| `cast handoff --to codex` | No: linked new session, source pinned done | Yes | A brief (goal, decisions, verified, questions, next steps) | The thread is long and noisy; keep the conclusions |
| `cast spawn --subagent --agent codex` | No: nested worker | Yes | None, only your brief | Delegate one piece and get the result back |
| `cast exec --agent grok` | No conversation; the process is the session | Yes, short-lived | None, only the prompt (or `--resume`) | One answer inside a script |
| Auto-switch / fleet store | Yes | No, on fleet-store machines; otherwise a "continue" restarts parked sessions | All of it | Never stop on a usage limit |
| `cast migrate` | Yes | Yes, on another machine | Full thread, rebuilt there | Move work between laptop and cloud host |

## Edge cases worth knowing

- **A provider switch replaces the process.** If an agent runs `cast switch --agent codex` on its own session, that agent is about to be killed. The help text says so, and the agent should stop talking as the old one.
- **Cursor and Muse can't take over history.** Switching or forking into them is refused up front. Use a handoff or a worker instead.
- **The switch needs the checkout.** The rebuild happens on the machine that owns the session. If the project directory isn't there, the daemon refuses with "No local checkout for agent switch" rather than starting the agent in the wrong place.
- **Switches don't join an in-flight resume.** If the old agent is in the middle of restarting, the switch doesn't attach to that restart (that would quietly bring back the old agent). It interrupts it and rebuilds.
- **Some agents can't change model mid-session.** pi's model is chosen at launch (its own Ctrl+P menu isn't something codecast can drive), so a model change there goes through a restart.
- **Server-only messages are filtered out.** Internal rows such as workflow-run anchors are skipped when a transcript is written. Otherwise the new agent would see raw JSON and sync it back as if it had said it.
