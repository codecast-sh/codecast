
## Asking for a decision

A queued decision is not an interruption. Asking inline stops your human mid-thought and is
expensive, which is why the standing rule is to decide for yourself. `cast decide` is a
different channel: it lands in a queue they clear in one sitting, in their own time, so the
cost of asking is close to zero. The bar is therefore LOWER here than for interrupting — if
you would have picked a direction and mentioned it in passing, queue it instead.

Queue one when you are about to:

- pick between approaches that are hard to reverse later (a schema, a data model, a protocol),
- spend real money or their quota, or touch billing, auth, or anything user-facing in prod,
- delete or migrate data, or drop something that would need a backup to recover,
- resolve a tradeoff by taste rather than evidence — speed vs correctness, breadth vs depth,
- proceed on a guess about what they actually want the product to do.

Do NOT queue what you can answer by reading more code, and never queue a status update.

The answer arrives back here as a message.

```bash
cast decide "<one question>" \
  -o "First option :: what happens if chosen" \
  -o "Second option :: what happens instead" \
  --context -  <<'EOF'
The reasoning: what you found, the tradeoff, and why you cannot pick alone.
Write it so they can decide WITHOUT opening the session.
EOF
```

**The decision is the whole message.** It renders as a card — in the queue and inline in this
conversation, right where you ran the command — so everything the reader needs must be inside
it: what you found, what each option costs, why you cannot pick, and what you will do
meanwhile. Then say nothing more about it in prose. No summary of the options, no "I have
queued a decision about X", no restating the reasoning after the card: the reader sees the
card, and a second telling of the same thing is the noise this channel exists to remove. If
your reply after the command would only repeat the card, end your turn instead.

The bar: a bare question is useless. The context carries your reasoning, the tradeoff, and the
consequence of each option — the queue shows nothing else unless they open the session. For a
decision that deserves evidence (a migration, an audit, a design), write an HTML report and
attach it with `--report report.html`; it publishes like any page and renders embedded with
the question.

**A posted decision is yours to keep correct.** When the facts change, change the open
decision in place rather than posting a second one: `cast decide edit` rewrites its
question, options, context, or report and keeps its place in the queue. When the question no
longer applies, `cast decide cancel` withdraws it. Both act on this session's open decision;
`cast decide ls` lists every decision you posted with its id and how it was answered, and the
id also comes back when you post. An already answered decision cannot be edited — the answer is
in the conversation; act on it.

Blocking is the default: post it, then END YOUR TURN — the answer arrives as a user message.
`--advisory --default <n>` keeps you working with option n while the answer can override you
later. Use it ONLY when the default is cheap to undo: answers tend to land an hour later and
often disagree, and everything you build on the default in between is then work to unwind. If
reversing the default would cost more than waiting, block.

Ask sparingly. Every decision spends your human's attention; a question you could have resolved
by reading more code is noise in their queue.
<!-- /codecast-decide -->
