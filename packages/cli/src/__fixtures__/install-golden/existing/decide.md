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

When you hit a fork only your human can resolve — a tradeoff with real consequences, an
irreversible step, a judgment call about their product — hand them ONE well-formed decision
with `cast decide` instead of burying a question in prose. It lands in their decision queue,
where they clear the whole stack in one sitting; the answer arrives back here as a message.

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
attach it with `--report report.html`; it publishes like any artifact and renders with the
question.

Blocking is the default: post it, then END YOUR TURN — the answer arrives as a user message.
When you can safely proceed and only want oversight, pass `--advisory --default <n>`: keep
working with option n, and treat a later answer as an override.

Ask sparingly. Every decision spends your human's attention; a question you could have resolved
by reading more code is noise in their queue.
<!-- /codecast-decide -->
