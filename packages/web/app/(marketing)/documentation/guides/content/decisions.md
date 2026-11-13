When an agent reaches a choice only you can make, it has two bad options. It can stop and ask, which pulls you out of your own work to read a transcript. Or it can pick alone, and you find out after code depends on the pick.

With the Decision queue on, the agent writes one clear question, the options with what each one costs, and its reasoning. The question waits on the **Decisions** page until you get to it. You answer with a click or a number key, and the answer goes back to the session that asked as an ordinary message. The agent carries on from there.

![A session waiting on a decision: the question in large type, the agent's reasoning, numbered options each with its consequence, and a field to answer in your own words](/documentation/decisions/waiting.webp "A session waiting on your decision, with everything you need to answer on the card.")

Because a queued question costs you little, agents are told to ask more often than they would interrupt you. A choice they would otherwise have made silently and mentioned in passing goes to the queue.

## Turn it on

Open **Settings**, pick **Agent Features** under *Machines*, choose the computer your agents run on, and switch on **Decision queue** under *Working together*. **How it works** on the card shows an example.

Agents ask on their own once it is on. You can also tell them when to:

- "If you need my call on the caching strategy, queue a decision and keep going on the rest."
- "Before you pick a database for this, ask me with the options laid out."
- "Put the three layout options in front of me as a decision, with a page for each."

## The Decisions page

**Decisions** in the sidebar carries a count of the questions waiting on you. It opens a list: **Mine** for what you own, **Team** for the whole team's, plus **Unassigned**, **Escalated** and **Answered**. Filter by owner, area, kind or how long a question has waited, and switch between **List** and **Cards**.

![The Decisions page: a list of open questions from Acme's sessions, with Mine selected and counts on each tab](/documentation/decisions/decisions-page.webp "The Decisions page, with three questions waiting on you.")

Click a row to open the decision's own page: the question, the agent's full reasoning or the report it attached, a page per option when the agent made one, a discussion, and the answer controls. The arrows at the top, or the arrow keys, flip to the next and previous decision.

## Answer one at a time

**One at a time** walks the queue as full cards, each on the asking session's pane, so you can clear it in one sitting.

![One decision shown full screen, with its options numbered and the key hints for skip, dismiss and open the session](/documentation/decisions/one-at-a-time.webp "Working through the queue one decision at a time.")

| Key | What it does |
|-----|--------------|
| `1` to `9` | Answer with that option |
| `t` | **Or answer in your own words**: your text goes to the agent as a message |
| `s` | Skip for now |
| `x` | Dismiss. The question leaves the queue and the agent is not told |
| `o` | Open the session |
| `esc` | Leave the queue |

The order follows a rule. Questions holding an agent up come first, then questions from sessions that have stopped, then questions the agent is already working around. Inside each group the oldest comes first. Each card shows its age in time and in messages since it was asked, so a question the thread has moved past is easy to spot.

A permission prompt or a question an agent asked in its own terminal shows under *Waiting in a terminal*. You answer those in the session itself, with its real approve and deny controls; number keys never approve anything.

## In the conversation

Opening a session that is waiting on you shows the decision as a full card, headed *Waiting on your decision*. Answer it there, share it with the share button, or click **Read the thread** to fold it away and see what led up to it.

After you answer, the transcript keeps the record: the question marked answered with a check on your choice, and your answer as a message linked back to the ask.

![The answered decision in the transcript: the chosen option checked, the answer as a message, and the agent's reply](/documentation/decisions/answered.webp "The same decision after answering, with the agent's next step below it.")

Some questions don't need to hold the agent up. When the agent has a sensible default that is cheap to undo, it keeps working on it and the question docks above the message box with its options, a field to **Answer in your own words**, and **Open** for the whole question. Your answer can still override the default. Agents are told to wait instead whenever undoing the default would cost more than waiting.

![A question docked above the message box while the agent keeps working, with two option buttons, an answer field and Open](/documentation/decisions/steer-dock.webp "A question the agent is working around, docked above the message box.")

When a message names several open decisions, a bar above it counts them, and **Go through them** opens exactly those as full pages you flip through.

## On your phone

In the iPhone app, a **to decide** badge beside the Inbox title shows the count and opens Decisions, with **Mine** and **Team** and **Answer one at a time**. Each card has its options, **Dismiss** and **Skip**, and moves to the next when you answer.

![The iPhone decision card with the question, two options and Dismiss and Skip at the bottom](/documentation/decisions/phone-decision.webp "A decision on the iPhone.")

## Stacks

When several decisions belong together, such as a launch checklist, switch the Decisions page to **Cards**, click **group into a stack**, tick the cards, name the stack and click **create the stack**. On the stack's page you can set a **Due** date and an **Auto default**: after that many hours, any question the agent was already working around is answered with its default. Questions holding an agent up are never answered for you.

## What agents are told

- One question per decision, with the reasoning written so you can answer without opening the session.
- Ask before choices that are hard to reverse, that spend money, that touch production or user data, or that come down to taste.
- Never ask what reading more code would answer, and never use the queue for status updates.
- Keep the ask correct: edit the open question when the facts change, and withdraw it when it no longer matters. A withdrawn question shows as withdrawn in the conversation.
