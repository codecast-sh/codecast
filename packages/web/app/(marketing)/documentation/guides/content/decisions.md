An agent that reaches a real fork has two bad options. It can stop and ask, which pulls you out of your own work to read a transcript. Or it can pick a direction alone, and you find out after code depends on it.

With the Decision queue on, there is a third way. The agent writes one clear question, the options with what each one costs, and its reasoning, and the question waits in **Questions** until you get to it. You clear the queue in one sitting, a key per answer, and each answer goes back to the session that asked as an ordinary message. The agent carries on from there.

![A session waiting on a decision: the question in large type, the agent's reasoning, two numbered options each with its consequence, and links to answer in your own words or dismiss](/documentation/decisions/waiting.webp "A session waiting on your decision. The question, the reasoning and the options are all on the card, so you can answer without reading the thread.")

Because a queued question costs you almost nothing to receive, agents are told to ask more often than they would interrupt you: a choice they would otherwise have made silently and mentioned in passing goes to the queue instead.

## Turn it on

Open **Agent features** from your account menu, pick the computer your agents run on, and switch on **Decision queue**, under *Working together*. Click **How it works** on the card for an example.

Agents ask on their own once it is on. You can also tell them when to:

- "If you need my call on the caching strategy, queue a decision and keep going on the rest."
- "Before you pick a database for this, ask me with the options laid out."
- "Put the three layout options in front of me as a decision, with a page for each."

## Answer in Questions

**Questions** in the sidebar shows a count of the decisions waiting on you. It opens the queue as a list of compact cards. Click **one at a time** to work through it as full cards, one after another.

```figure
QueueClearingFigure
Three asks in the queue. Each answer clears the card, the next one rises, and the session that asked goes back to work with your answer.
```

On a card:

| Key | What it does |
|-----|--------------|
| `1` to `9` | Answer with that option |
| `t` | **Or answer in your own words**: your text goes to the agent as a message |
| `s` | Skip it for now |
| `x` | Dismiss it. It leaves the queue and the agent is not told |
| `o` | Open the session |
| `esc` | Leave the queue |

The order follows a rule, not a score. Questions that are holding an agent up come first, then questions from sessions that have stopped, then questions the agent is already working around. Inside each group the oldest comes first, because a waiting agent costs more the longer it waits. Each card also shows its age twice, in time and in messages since it was asked, so a question the thread has already moved past is easy to spot.

A permission prompt or a question an agent asked in its own terminal waits in the same queue, under *Waiting in a terminal*. Those are answered in the session itself, with its real Approve and Deny controls; number keys never approve anything.

## In the conversation

When a session is waiting on you, opening it shows the decision as a full card, headed *Waiting on your decision*, with **Copy link** to send it to someone and **Read the thread** to see what led up to it. Answer it right there with a click or a number key.

After you answer, the transcript keeps the record: the question marked *answered* with a check on your choice, and your answer as a message linked back to the ask.

![The answered decision in the transcript: the question with an Answered chip, the chosen option checked, the person's answer as a message, and the agent's reply](/documentation/decisions/answered.webp "The same decision after answering. The agent wrote the README with the format that was picked.")

Some questions don't need to hold the agent up. When the agent has a sensible default that is cheap to undo, it keeps working on that default and the ask folds into a small *Asked for your steer* pill above the composer. Your answer can still override it. Agents are told to wait instead whenever undoing the default would cost more than waiting for you.

Every decision also has its own page, which you reach from the card or by the link. It holds the question, the full reasoning or a report the agent attached, a page per option when the agent made one, a discussion, and the answer controls.

## On your phone

```figure
PhoneQueueFigure
The iPhone app walks the same queue one decision at a time, and moves to the next when you answer, skip or dismiss.
```

## Stacks

When several decisions belong together, such as a launch checklist, click **group into a stack** in the list, tick the cards, name the stack and create it. A stack is cleared in one sitting like a checklist. On its page you can set a **Due** date, and an **Auto default**: after that many hours, any question the agent was already working around is answered with its default. Questions that are holding an agent up are never answered for you.

## What agents are told

- One question per decision, with the reasoning written so you can answer without opening the session.
- Ask before choices that are hard to reverse, that spend money, that touch production or user data, or that come down to taste.
- Never ask what reading more code would answer, and never use the queue for status updates.
- Keep the ask correct: if the facts change, edit the open question in place, and withdraw it if it no longer matters. A withdrawn question shows as withdrawn in the conversation.
