
## Asking for a decision

`cast decide` puts a question in a queue the human clears in one sitting, so unlike asking inline (in prose or through your harness's question tool) it does not stop them mid-thought, and the bar is lower. If you would have picked a direction and mentioned it in passing, queue it instead. Queue one before you:

- pick between approaches that are hard to reverse (a schema, a data model, a protocol),
- spend real money or their quota, or touch billing, auth, or anything user-facing in prod,
- delete or migrate data, or drop something recoverable only from a backup,
- settle a tradeoff by taste rather than evidence,
- proceed on a guess about what they want the product to do.

Never queue what reading more code answers, a status update, or a probe or test sample: every ask reaches the human's real queue and phone at once.

```bash
cast decide "<one question>" \
  -o "First option :: what happens if chosen" \
  -o "Second option :: what happens instead" \
  --context -  <<'EOF'
What you would pick and why, then what the choice turns on.
EOF
```

**The card is the whole message, written for someone who was not here.** The person answering knows the product and its people but did not follow this session: they read the card once, in their queue or on their phone, with nothing else open, and answer without opening the session. Name things the way they would. The names this work coined, its shorthand, and ids or references only the session explains (a task, a trigger, a script, "the rule from earlier") mean nothing to them, and neither does a pointer back to something said earlier in the session, their own words included: say what the thing is instead. The question is the choice as they would put it to themselves. Each option says what happens to the product or the people it reaches, then `::` and the fact that sizes it. The context opens on what you would pick and why, then gives only what the choice turns on: the finding that forces it, what cuts against your pick, and what you do meanwhile. It reads in a minute, under about 150 words; how you got there and the supporting detail go in `--report report.html`, and a side-by-side comparison in a `cast-canvas` after the opening. Every number and claim on it is one the session established; an estimate says it is one. Before posting, read the card as that person: whatever they would have to ask you about, rewrite. After posting, don't repeat the options in your reply; if it would only repeat the card, end your turn.

**Blocking is the default**: post, then end your turn; the answer arrives as a user message. `--advisory --default <n>` keeps you working on option n, but only when that default is cheap to undo. When facts change, `cast decide edit` rewrites your open decision in place and `cast decide cancel` withdraws one the work has moved past. `cast guide decide` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-decide -->
