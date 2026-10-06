An agent at a real fork (a schema, a data migration, a tradeoff that turns on taste) has two bad options today. It can stop and ask inline, which pulls you out of your own work to read a transcript and reconstruct the question. Or it can pick alone, and you find out after code depends on the choice. Codecast gives it a third: the agent writes the question, the options and its reasoning into a card, the card waits in your queue, and you clear the queue when you sit down. Each answer goes back to the session that asked, as a normal message.

Because a queued question costs you almost nothing to receive, the bar for asking drops. A choice the agent would have made silently and mentioned in passing goes to the queue instead, where you can overrule it before it matters.

![The product film's Decide chapter: over a dimmed conversation 'Retry failed webhooks', a decision card sd-1290 asks 'Exponential or fixed backoff?' with context saying a fork replayed the failures both ways, then three options each with cost and risk: Exponential 5 attempts (cost 40 lines, today), Fixed every 30s (cost 15 lines, risk lost 3 events in the replay), Linear every 5 minutes (risk slow after a short blip), and 'or type an answer in your own words'](/blog/field-manual/decisions-pending.webp "The card is the whole message. The agent forked itself to replay the failures both ways, and each option carries its cost and its risk, so you can choose without opening the session.")
![The same ask after answering: the question, its context, and a check mark next to 'Exponential, 5 attempts'; behind it the conversation continues with '212 tests pass. MAX_ATTEMPTS is 5 now. I'll split the rest between two workers'](/blog/field-manual/decisions-answered.webp "One keypress later. The ask settles into the transcript with its answer, and the agent, which had ended its turn and parked, picks up from it.")

## What a card holds

One question, two to nine options, and the context: what the agent found, what each option costs, and why it cannot pick alone. Each option can carry a line saying what happens if you choose it, so you compare outcomes where you click, and there is always room to type an answer in your own words instead.

The agent is pushed toward good cards: a bare question is refused, it sees the card exactly as you will, and it is warned when the context is thin. Asking the same question twice updates the open card, so a crashed and retried agent does not spam your queue.

![The decisions feature page: on the left, what the agent sends; on the right, the card the human sees: 'Which schema wins?', the context as a quote, an embedded report table 'Where each id comes from' (daemon: file path, web index: frontmatter, notes indexed twice: 38), and two option buttons](/blog/field-manual/decisions-card.webp "From `/features/decisions`: what the agent sends, and what you see. The attached report embeds under the question.")

## The queue

**Questions** in the sidebar counts what is waiting on you and opens the queue. The order is a rule, not a score: asks blocking a live session first, then asks on a session that has stopped, oldest first in each, because a parked agent costs more the longer it waits. The top card takes the keyboard, and the one-at-a-time view puts each question full size over its real conversation, "decision 3 of 7":

| Key | What it does |
|---|---|
| `1` to `9` | answer with that option |
| `T` | type your own answer |
| `S` | skip for now |
| `X` | dismiss; the agent is not told |
| `O` | open the session |
| `K` / `J` | peek at the thread behind the card, then bring the question back |
| `Esc` | leave the queue |

Permission prompts and questions an agent asked in its own terminal wait in the same queue, with one safety detail: on a permission card the digits are off and only `Y` and `N` answer, so a digit meant for the previous card can never approve a command.

## In the conversation

Every ask also appears in its conversation. A blocking ask opens as a full card over the pane, with its age and how many messages the session has written since (traffic after a blocking ask usually means someone already answered in the thread). Once answered, the transcript keeps a decision row with your choice in green, and your answer arrives as a normal message from you, linked back to the ask.

## Blocking, or advisory with a default

Blocking is the default: the session stays parked until you answer. An *advisory* ask lets the agent carry on with a default while your answer can still override it; it stays out of the queue and folds to a pill above the composer, "Asked for your steer". The rule the agent is given is the interesting part: advisory only when the default is cheap to undo. Answers often land an hour later and disagree, and everything built on the default in that hour is work to unwind. If reversing would cost more than waiting, block.

![Two panels side by side. Blocking: the ask 'Approve dropping agent_runs_v1?', and the session showing 'Waiting on your decision' then 'Decision: Hold'. Advisory: 'Back off or switch keys?' with a folded pill 'Asked for your steer' above the composer and option 1 marked 'proceeding with this'](/blog/field-manual/decisions-advisory.webp "Blocking parks the session; advisory keeps it moving on its default and folds the ask to a pill above the composer.")

## Evidence: reports and option pages

A decision that deserves proof gets a page: a report embedded under the question, or each option built as its own page, so two designs sit side by side and a digit picks one. An ask can also want several options, an order or a short form, and every decision has its own shareable page.

![The decisions feature page section 'When a paragraph is not enough, the card carries the evidence': an ask 'Which layout?' with two option pages, and the resulting card showing two page previews side by side, Dense and Roomy, each with an 'open' link](/blog/field-manual/decisions-report.webp "Option pages: the agent built both layouts and published each, so you choose between rendered pages, not descriptions.")

## Keeping a card true

Until someone answers, a card belongs to the agent. When the facts change it rewrites the card in place, keeping its spot in your queue; when the question stops mattering it withdraws it, struck through in the thread. After two hours or thirty messages the agent is told to do one or the other.

## From your phone

The phone app keeps the same queue in the same order, with a badge by the inbox title. **Answer one at a time** walks it: tap an option, feel the confirmation, and the next decision slides in ("3 of 7"). The answer reaches the agent exactly as from the desktop, so the agents resume before you are back at a keyboard.

## Stacks: a set you clear in one sitting

A stack groups related asks, like everything a launch needs from you, into one checklist. A stack can have a due time (overdue sorts first), a deadline after which *advisory* members take their defaults (blocking ones never answer themselves), and a role it is delegated to, though questions about production, billing, data or access still come to a person.

![A 'Launch checklist ds-7' stack, due 2h ago, with 2 of 5 cleared: two struck-through answered questions, the current one 'Send the launch email to the waitlist?' with options Send Tuesday 9am and Hold a week, and two advisory members below with an 'answer all defaults (2)' button](/blog/field-manual/decisions-stack.webp "A launch checklist: answered members strike through, advisory members can all take their defaults with one click, and `N`/`P` walk the stack.")

> **Why it matters.** Asking inline makes a question cost the human an interruption, so agents learn not to ask. A queue inverts that: the cost moves to a moment you choose, so agents can afford to ask about the things that actually deserve a person (hard to reverse, spends money, deletes data, a guess about what the product should do) and you can afford to answer twenty of them over coffee. What *not* to queue is just as explicit in the agent's instructions: anything more reading would answer, status updates, and probes.
