Every coding agent keeps its own transcript in its own format. Claude Code writes one kind of log, Codex another, Grok and pi and OpenCode each something else. Normally that means a conversation is stuck with the agent that started it: if Claude has spent two hours on a bug and you want Codex to look at it, you copy and paste.

Codecast doesn't have that problem, because the conversation already lives on its server. The server holds one neutral copy of every message: your turns, the agent's turns, every tool call and every tool result. Each agent's own transcript is just one rendering of that copy. To move a conversation to another agent, codecast writes the history out in that agent's format and starts it there. Everything in this chapter (switching agents, forking onto another one, moving to another account or another machine) is that one trick applied in different places.

![A conversation drawn as a tree: a fork that carries the history, Codex and Gemini workers that report back, then the trunk changes color in place with a 'now using Codex' marker and Codex continues](/blog/field-manual/switch-treehero.webp "One conversation as a tree. Forks carry the history (solid lines). Workers on Codex and Gemini start fresh and report back (dashed lines). At the bottom the trunk changes color in place: same thread, new agent.")

## The session control

Every conversation header shows the agent's icon and, next to it, the model it is running ("Fable", "gpt-5.5-codex") with an effort glyph. If the session is yours, that label is a button. Click it and a panel opens.

The top of the panel says where you are: the agent, the model, and one line of state. "Live session · picks apply in place" means a model or effort change reaches the running agent right now. "Blank session · picks apply at launch" means nothing has been said yet, so whatever you pick is simply what starts. Under that sit the model and effort pickers, and then a section called **Move this session** with three rows:

- **Switch agent**: same session, another agent.
- **Fork as**: a copy of this session on another agent.
- **Hand off to**: a fresh session, seeded with a brief.

Each row slides to a list of agents written out in full: your pinned agents plus the one you are on, which is ringed so the list says where you are. Codecast supports eight local agents (Claude Code, Codex, Cursor, OpenCode, pi, Grok, Muse Spark and Gemini), and the list only shows the ones you pinned. The same three verbs, plus "Change model & effort…", are in the command palette when a conversation is open, so you can do all of this without the mouse.

Teammates see the model as plain text; the control belongs to the session's owners.

## Switch agent: same thread, new agent

Pick **Switch agent → Codex** and the conversation keeps its id. The inbox card, the links, the bound task and the share URL stay exactly where they were. What changes is who answers.

What happens next depends on what you changed:

- **A different model on the same agent** (Fable to Sonnet, or a new effort level) usually needs no restart. Codecast sends the running agent the same `/model` command you would have typed, and the agent carries on with the next turn.
- **A different agent** replaces the process. Codecast stops the old agent, interrupting its turn if it is mid-answer, rebuilds the conversation in the new agent's format on the machine that runs the session, and starts the new agent on it. A message you had queued for the old agent is delivered to the new one.
- **A blank session** has nothing to rebuild, so it just launches as the new agent.

Where the agent changed, a divider lands in the thread: a thin rule that reads "now using Codex", with the previous agent and model beside it. The divider is a real message, so it is also in the history the new agent reads. The new agent knows a switch happened and that the history above is the same thread.

![A conversation: the user asks 'Reply with only the word PONG', Claude answers PONG, a divider reads 'now using OpenCode was Claude · Fable', another session asks 'What word did you reply with earlier?', and OpenCode answers PONG](/blog/field-manual/switch-live-divider-thread.webp "A switch, as the app draws it. Claude answers PONG. The divider marks the move to OpenCode. Asked later what it said, OpenCode answers PONG from the rebuilt history, even though it never saw the first turn.")

### How the transcript is rebuilt

The new agent never sees a summary. It gets the conversation itself, written the way that agent would have written it: your messages, the previous agent's replies, and each tool call paired with its result, translated into the new agent's own shape for tool calls. To Codex, two hours of Claude's work look like two hours of its own session.

What does not carry over is anything that lived only inside the old agent: its hidden reasoning and its prompt cache. That is usually what you want from a second opinion. The new model reads the same evidence and reaches its own conclusions.

Very long conversations are trimmed to fit the new agent's context window. The trim keeps the recent part of the thread and every instruction you gave earlier, and adds a note at the top saying how many older messages were left out and how to read them. Nothing is lost for good: the server copy stays whole, and the agent is told where to find the rest.

> **Why it matters.** The usual reason to switch is a second pair of eyes from a different model on the same evidence. Because the history is rebuilt rather than summarized, "Codex, look at what Claude did" costs one click and nothing gets paraphrased away.

### Agents that can't take over a history

Six of the eight agents can be rebuilt from the server copy. Cursor and Muse can't, so in the Switch and Fork lists their rows are greyed out with "can't rebuild history". The server enforces the same rule, so nothing ends up half-switched. A blank session is the exception: with no history to carry, it can become anything. For Cursor and Muse, use a handoff or a worker instead; both start from a prompt rather than a transcript.

## Fork as: try another agent without giving this one up

**Fork as → Codex** makes a new conversation with a copy of this one and leaves the original running. You land in the fork at once, with a progress count while the messages copy over, and then it starts on the new agent with the rebuilt history. The two sessions are linked in each other's lineage, and you can steer them independently.

## Hand off to: keep the conclusions, drop the noise

A switch keeps every message. Sometimes that is the problem: the thread is three hundred turns of dead ends, and what the next agent needs is the conclusions.

**Hand off to** asks for an agent, then shows a second step: the model and effort for the new session, and a box labeled "What should the next session do first?". Press the button (it reads "Hand off on" plus the model) and codecast writes a brief of the source session: the goal, the decisions, what is verified, open questions, and ordered next steps, naming exact files and ids. The brief becomes the first prompt of a new session in the same directory. The new session is a normal card in your inbox, bound to the same task or plan, and the old one is marked as handed off. A toast says "Handed off to" with the new session's id.

The two stay linked. The header's overflow menu has a Lineage section with "Handed off from" on the new session and "Continued in" on the old one, so you can walk back to the full transcript whenever the brief isn't enough. The brief itself ends with pointers into the source transcript for the same reason.

Because the new agent starts from a prompt rather than a rebuilt history, a handoff can target any agent, Cursor and Muse included.

![A handoff brief with Goal, Decisions, Verified, Open questions and Next steps, a footer showing the source marked done and a new Codex session linked to the same task](/blog/field-manual/switch-handoff-mock.webp "A handoff brief. The footer is the whole contract: the source session is marked done, and the new Codex session is linked and bound to the same task.")

## Workers on other agents

Sometimes you don't want to move the conversation at all. You want a different agent to do one piece of it. Ask your session for that in plain words ("have Codex review the diff", "split the dashboard out to a Cursor worker") and it starts a worker on that agent. The agent does this with one command; your agents already know how, because the instructions codecast installs tell them.

A worker is a full session, but it is yours to manage, not a new card competing for your attention. It nests under the session that started it in the inbox. The start shows up in your thread as a small card naming the worker, and the worker's own header links back to its lead. When the worker finishes, gets blocked, or stops at a permission prompt, the lead session is woken and reads the result, so you hear about it once, from the session you were already talking to.

Workers start with no shared history, only the brief the lead wrote. That is why any agent works here, including the ones that can't take over a conversation.

![Two worker sessions side by side under one lead: 'Dashboard retry UI' running on Cursor composer-2 and 'Webhook API half' running on Codex gpt-5.5-codex, both working on parts of a webhook retry feature](/blog/field-manual/switch-fanout.webp "One lead split webhook-retry work into a Cursor worker for the dashboard and a Codex worker for the API. Each is a full session on its own agent and model, nested under the lead.")

## Usage limits: same agent, another account

A usage limit is the most common reason a session stops, and codecast treats it as one more kind of switch: same agent, same conversation, different account.

When an agent hits a limit, the thread shows a **Usage limit** card in place of the error. It says which window closed and when it opens again, and one line saying what will happen next, read from that machine's setting rather than generic advice: "Auto-switch is on: moving this session to an account with room, nothing to do", or "Resumes on its own when the window resets", or "Waiting for you to approve an account switch". When you have another saved account with room, the card offers a button to continue on it, and once a recovery starts the same card follows it through: restarting on the new account, picking up the turn, resumed. A minute of restart reads as progress, never as a stuck error.

What codecast does on a limit is a per-machine choice under Settings → Claude accounts, "When a session hits a usage limit":

- **Ask before switching**: recommend the saved account with the most headroom and wait for your approval. Sessions still resume on their own when the window resets.
- **Switch automatically**: move the machine to the saved account with the most headroom and continue the parked sessions without asking. If the window has already reset, it just continues; if every account is out, it waits for the earliest reset.
- **Resume at reset only**: never change accounts, continue when this account's window reopens.
- **Do nothing**: parked sessions wait for you.

On a laptop, every session codecast runs reads its Claude login from one shared store. A switch rewrites that store, and every running session picks up the new account within about 30 seconds, mid-turn, without a restart. Machines set up this way also switch ahead: they leave an account at 95% of its 5-hour window (97% of the weekly one) before anything gets parked. Workers follow their lead, since a Claude worker runs inside its lead's process.

Codex accounts can be saved, but switching between them isn't supported yet. A Codex session recovers by continuing after its window resets.

## Another machine: moving to a cloud host

The same rebuild moves a session between your laptop and a cloud host. Right-click a session card and choose **Move to machine**, or open the palette on one or several selected sessions and pick "Move to machine…". The list shows your laptops first, then your cloud hosts, and a toast confirms "Moving 3 sessions to" the machine you chose, noting any it skipped and why.

A session in the middle of a turn finishes that turn first (after ten minutes it is interrupted). A message you send while it is moving is held and delivered on the destination. A session stopped at a permission prompt moves at once and asks again on the other side. Settings → Migration shows each batch in flight.

On the destination, the conversation is rebuilt from the server copy exactly as in a switch, because that machine never ran it. A divider in the thread reads "now running on" the host, and the agent is told it moved: running processes, open ports and files outside the working tree stayed behind. The [cloud hosts](/blog/field-manual/cloud-hosts) chapter covers the hosts themselves.

## Which one to pick

| What you want | What to pick in the app | What happens |
|---|---|---|
| A cheaper or stronger model for the next step | Session control → Model, or Effort | The running agent switches on its next turn. Nothing restarts, no history moves. |
| A second opinion, or an agent better at what comes next | Session control → Switch agent | Same thread and id. A "now using …" divider, and the new agent continues on the full rebuilt history. |
| To try another agent and keep the original going | Session control → Fork as | A new linked session with a copy of the history, on the new agent. The original keeps running. |
| A clean start: the thread is long and noisy | Session control → Hand off to, plus a direction | A new session that starts from a brief. The old one is marked handed off; both are linked. Any agent works. |
| Another agent to do one piece and report back | Ask your session for a worker on that agent | A nested worker starts from a brief. Your session is woken when it finishes. |
| Not to stop on a usage limit | Settings → Claude accounts → Switch automatically | Parked sessions continue on the account with the most room, or at reset. |
| The session running somewhere else | Card menu or palette → Move to machine | It finishes its turn, moves, and continues on the full history there. |

## Edge cases worth knowing

- **Switching agents replaces the process.** Anything the old agent had running in its own process (a background job it started, a local server it was watching) ends with it.
- **The switch happens where the session runs.** The rebuild needs the project checkout on that machine. If the directory is gone, the switch is refused rather than starting the agent somewhere else.
- **Some agents pick their model at launch.** pi, for one, can't change models mid-session, so a model change there goes through a quick restart instead of applying in place.
- **Cloud agents and hosted assistants have fewer moves.** A session running on a cloud provider's machines can be forked or handed off but not switched in place, and a hosted assistant conversation offers no move verbs at all, since it doesn't run on a machine of yours.
