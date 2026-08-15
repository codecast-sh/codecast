
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
