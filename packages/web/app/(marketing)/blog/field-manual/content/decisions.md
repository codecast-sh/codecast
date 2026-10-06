An agent at a real fork (a schema, a data migration, a tradeoff that turns on taste) has two bad options today. It can stop and ask inline, which pulls you out of your own work to read a transcript and reconstruct the question. Or it can pick alone, and you find out after code depends on the choice. `cast decide` is the third option: the agent writes the question, the options and its reasoning into a card, the card waits in your queue, and you clear the queue when you sit down. Each answer goes back to the session that asked, as a normal message.

Because a queued question costs you almost nothing to receive, the bar for asking drops. A choice the agent would have made silently and mentioned in passing goes to the queue instead, where you can overrule it before it matters.

![The product film's Decide chapter: over a dimmed conversation 'Retry failed webhooks', a decision card sd-1290 asks 'Exponential or fixed backoff?' with context saying a fork replayed the failures both ways, then three options each with cost and risk: Exponential 5 attempts (cost 40 lines, today), Fixed every 30s (cost 15 lines, risk lost 3 events in the replay), Linear every 5 minutes (risk slow after a short blip), and 'or type an answer in your own words'](/blog/field-manual/decisions-pending.webp "The card is the whole message. The agent forked itself to replay the failures both ways, and each option carries its cost and its risk, so you can choose without opening the session.")
![The same card after answering: it collapses to the question, its context, and a check mark next to 'Exponential, 5 attempts'; behind it the conversation continues with '212 tests pass. MAX_ATTEMPTS is 5 now. I'll split the rest between two workers'](/blog/field-manual/decisions-answered.webp "One keypress later. The card folds to its answer, and the agent, which had ended its turn and parked, picks up from the answer.")

## How a card is written

One question, 2 to 9 options (mapped to keys 1 to 9), and the context: what the agent found, what each option costs, and why it cannot pick. Text after `::` in an option becomes the consequence printed under its label, so you compare outcomes where you click.

```terminal
$ cast decide "Which schema wins?" \
    -o "Frontmatter wins :: the daemon changes" \
    -o "Path wins :: old links break" \
    --report id-audit.html \
    --context - <<'EOF'
The daemon writes note ids from the file path. The web index derives
them from frontmatter. A rename keeps one id and changes the other, so
the same note indexes twice. Either side can be authoritative.
EOF

Decision posted: Which schema wins?
  id: sd-41
  1. Frontmatter wins: the daemon changes
  2. Path wins: old links break
  report: https://codecast.sh/a/id-audit

Blocking: end your turn now. The answer arrives as a user message.
```

The CLI pushes back on lazy cards. It refuses a bare question outright: a card needs `--context`, `--report`, `--doc` or `--card`. It prints the card back to the agent so the agent sees what you will see, and it warns when there is no report and under 200 characters of context, or when no option says what happens if chosen. Posting the same question again from the same session updates the open row instead of adding a duplicate, so a crashed and retried agent does not spam the queue.

![The decisions feature page: on the left, the cast decide command with two options, --report id-audit.html and a heredoc context, and its 'Decision posted' output; on the right, the card the human sees: 'Which schema wins?', the context as a quote, an embedded report table 'Where each id comes from' (daemon: file path, web index: frontmatter, notes indexed twice: 38), and two option buttons](/blog/field-manual/decisions-card.webp "From `/features/decisions`: what the agent runs, and what you see. The `--report` page embeds under the question.")

## Blocking, or advisory with a default

Blocking is the default: the agent posts and ends its turn, and the session stays parked until you answer. Nothing is locked; the CLI tells the agent to stop, and the agent's instructions say the same. `--advisory --default n` lets the agent carry on with option n while your answer can still override it. In the session view an advisory ask folds to one pill above the composer, so the thread stays the main event, and it sorts after every blocking ask in your queue.

The rule the agent is given is the interesting part: advisory only when the default is cheap to undo. Answers often land an hour later and disagree, and everything built on the default in that hour is work to unwind. If reversing would cost more than waiting, block.

![Two panels side by side. Blocking: cast decide 'Approve dropping agent_runs_v1?' with output 'Blocking: end your turn now', and the session showing 'Waiting on your decision' then 'Decision: Hold'. Advisory: cast decide 'Back off or switch keys?' --advisory --default 1 with output 'Advisory: continue with your default', and a folded pill 'Asked for your steer' above the composer with option 1 marked 'proceeding with this'](/blog/field-manual/decisions-advisory.webp "Blocking parks the session; advisory keeps it moving on option 1 and folds the ask to a pill. `cast decide edit --blocking` turns an advisory ask into a blocking one.")

## The queue

Your queue lives at `/questions` on the web and in the phone app, and every card also renders inline in the conversation that asked. The order is a rule, not a score: blocked asks whose session can still take an answer come first, then blocked asks on a stopped session, then advisory asks. Inside each group the oldest leads, because a parked agent costs more the longer it waits. Each ask shows its age two ways, wall clock and messages the session has written since; a blocking ask with traffic after it usually means someone already answered in the thread.

| Key | In step mode |
|---|---|
| `1` to `9` | answer with that option |
| `t` | type your own answer |
| `s` | skip for now |
| `x` | dismiss; the agent is not told |
| `o` | open the session |
| `esc` | leave the queue |

An answer marks the row answered at once and sends a user message into the asking session, `Decision: <label>`, rendered as an answer linked back to the ask. Answering from a shell (`cast decide answer sd-41 2`) writes the same message. The first answer wins; a second changes nothing. Permission prompts and an agent's own terminal questions wait in the same queue, with one safety detail: on a permission card the digits are off and only `y` and `n` answer, so a digit meant for the previous card can never approve a command.

## Evidence: reports, option pages, documents

A decision that deserves proof gets a page. `--report` publishes an HTML or markdown file through the same path as `cast publish` and embeds it under the question. `--option-page n=file.html` gives each option its own page, so two designs sit side by side. `--doc` attaches a long markdown body. Beyond a single choice, `--kind multi|rank|form` asks for several, an order, or a short form, `--line` asks for one line of text, and `--spec` takes the whole decision as JSON with cost, risk and evidence per option. A card with any of these links to its own page at `/decisions/sd-N`.

![The decisions feature page section 'When a paragraph is not enough, the card carries the evidence': a cast decide 'Which layout?' command with --option-page 1=dense.html --option-page 2=roomy.html, and the resulting card showing two page previews side by side, Dense and Roomy, each with an 'open' link](/blog/field-manual/decisions-report.webp "Option pages: the agent built both layouts and published each, so you choose between rendered pages, not descriptions.")

## Keeping a card true: edit and cancel

A posted decision belongs to the agent until someone answers. When the facts change, `cast decide edit` rewrites the question, options, context or report in place, keeping the id, the age and the spot in your queue. When the question stops mattering, `cast decide cancel` withdraws it and the conversation shows it as withdrawn. Staleness is measured, not hoped for: each ask records the session's message count when posted, and after 2 hours or 30 messages the CLI tells the agent to edit or cancel it. Once answered, a card cannot be edited; to change course you send the session a message.

```terminal
$ cast decide edit --context - <<'EOF'      # new facts: rewrite the open card
The load test finished: exponential lost 0 events, fixed lost 3.
EOF
$ cast decide cancel                        # the question no longer applies
$ cast decide ls                            # this session's asks, answers, staleness
```

## Stacks: a set you clear in one sitting

A stack groups related asks, like everything a launch needs from you, into a checklist with an id such as `ds-7`. An agent creates one and appends to it with `--stack`, or you tick cards in the queue and group them yourself. A stack can carry a due time (`--due tomorrow`; overdue stacks sort first), an auto default (`--auto-default 24h` answers *advisory* members with their declared default after the deadline, from a server job every 5 minutes; blocking members never answer themselves), and a delegate role that answers every open category for its members, while protected questions (production, billing, data, access) still come to a person.

![A 'Launch checklist ds-7' stack, due 2h ago, with 2 of 5 cleared: two struck-through answered questions, the current one 'Send the launch email to the waitlist?' with options Send Tuesday 9am and Hold a week, and two advisory members below with an 'answer all defaults (2)' button; beside it the cast stack create, decide --stack, policy, reorder and delegate commands](/blog/field-manual/decisions-stack.webp "A launch checklist: answered members strike through, advisory members can all take their defaults with one click, and `n`/`p` walk the stack.")

> **Why it matters.** Asking inline makes a question cost the human an interruption, so agents learn not to ask. A queue inverts that: the cost moves to a moment you choose, so agents can afford to ask about the things that actually deserve a person (hard to reverse, spends money, deletes data, a guess about what the product should do) and you can afford to answer twenty of them over coffee. The rules for what *not* to queue are equally explicit in the agent's instructions: anything more reading would answer, status updates, and probes.
