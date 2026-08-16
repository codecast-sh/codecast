# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

## Referencing objects

STALE REFERENCES BODY — the shared section that ten of the eleven snippets
refresh as a side effect of installing. The one that does not (`visual`) leaves
this text exactly as it stands.
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

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

The bar: a bare question is useless. The context carries your reasoning, the tradeoff, and the
consequence of each option — the queue shows nothing else unless they open the session. For a
decision that deserves evidence (a migration, an audit, a design), write an HTML report and
attach it with `--report report.html`; it publishes like any page and renders embedded with
the question.

Blocking is the default: post it, then END YOUR TURN — the answer arrives as a user message.
When you can safely proceed and only want oversight, pass `--advisory --default <n>`: keep
working with option n, and treat a later answer as an override.

Ask sparingly. Every decision spends your human's attention; a question you could have resolved
by reading more code is noise in their queue.
<!-- /codecast-decide -->
