
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
What you found, the tradeoff, and why you cannot pick alone.
EOF
```

**The card is the whole message.** It renders in the queue and inline here, so it must carry what you found, what each option costs, why you cannot pick, and what you will do meanwhile; they should decide without opening the session. When the options differ along something a reader compares (cost, risk, effort, before and after), open the context with a `cast-canvas` that lays them side by side. Attach evidence with `--report report.html`. After posting, don't repeat the options in your reply; if it would only repeat the card, end your turn.

**Blocking is the default**: post, then end your turn; the answer arrives as a user message. `--advisory --default <n>` keeps you working on option n, but only when that default is cheap to undo. When facts change, `cast decide edit` rewrites your open decision in place and `cast decide cancel` withdraws one the work has moved past. `cast guide decide` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-decide -->
