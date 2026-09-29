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

A queued decision is not an interruption. Asking inline stops the human mid-thought, which is why you normally decide for yourself; `cast decide` lands in a queue they clear in one sitting, so the bar here is LOWER. If you would have picked a direction and mentioned it in passing, queue it instead. Queue one before you:

- pick between approaches that are hard to reverse (a schema, a data model, a protocol),
- spend real money or their quota, or touch billing, auth, or anything user-facing in prod,
- delete or migrate data, or drop something recoverable only from a backup,
- settle a tradeoff by taste rather than evidence (speed vs correctness, breadth vs depth),
- proceed on a guess about what they want the product to do.

Never queue what reading more code answers, a status update, or a probe, test or layout sample: every ask reaches the human's real queue and phone at once, and a withdraw arrives after they have read it. To see how a card renders, mount the component on a fixture row or open an answered one.

```bash
cast decide "<one question>" \
  -o "First option :: what happens if chosen" \
  -o "Second option :: what happens instead" \
  --context -  <<'EOF'
The reasoning: what you found, the tradeoff, and why you cannot pick alone.
Write it so they can decide WITHOUT opening the session.
EOF
cast decide "<q>" -o … -o … --option-page 2=alt.html   # an option with its own page (a file, a slug, or a url)
cast stack remove ds-N sd-N | reorder ds-N sd-a,sd-b | policy ds-N --due tomorrow   # tend a stack; overdue sorts first
```

**The card is the whole message.** It renders in the queue and inline right here, so it must carry everything: what you found, what each option costs, why you cannot pick, and what you will do meanwhile. A bare question is useless; the queue shows nothing else unless they open the session. For a decision that deserves evidence (a migration, an audit, a design), attach an HTML report with `--report report.html`; it renders embedded with the question. After posting, say nothing more about it: no summary of the options, no "I have queued…". If your reply would only repeat the card, end your turn.

**Keep your decisions correct.** When facts change, `cast decide edit` rewrites the open decision's question, options, context or report in place, keeping its spot in the queue; `cast decide cancel` withdraws one that no longer applies. Both act on this session's open decision. `cast decide ls` lists every decision you posted with its id, answer, age and messages since it was asked (the id also comes back when you post). An answered decision cannot be edited; act on the answer. Before ending a long turn and whenever you post, cancel open asks the work has moved past: an answer to a question that stopped mattering costs attention and earns nothing.

**Blocking is the default**: post, then END YOUR TURN; the answer arrives as a user message. `--advisory --default <n>` keeps you working on option n while the answer can still override it. Use it ONLY when the default is cheap to undo: answers often land an hour later and disagree, and everything built on the default is then work to unwind. If reversing would cost more than waiting, block.

Ask sparingly: a question you could have answered by reading more code is noise in their queue.
<!-- cast @VERSION@ -->
<!-- /codecast-decide -->
