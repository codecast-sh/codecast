
## Asking for a decision

`cast decide` queues a question, so unlike an inline ask it does not stop the human mid-thought. Each still costs an answer, so ask only when it is theirs: intent nothing written settles, a fact only they hold, money beyond the run's budget, or an irreversible change whose mistake hits many. Decide the rest and say what you chose. Never a card: what reading answers, a status update, a probe or test, or deleting disposable or rebuildable data.

Never re-ask what an earlier card (`cast decide ls`), ruling or project instruction answered. When the answer deploys, spends, changes access or messages outside the team, pass `--category production|billing|data|access|external|product|limit`: the card is then a person's alone, else (outside a run) `review`, open to a granted role.

```bash
cast decide "<one question>" \
  -o "First option :: what happens if chosen" \
  -o "Second option :: what happens instead" \
  --impact "<1-5> :: what waits on the answer" \
  --context -  <<'EOF'
What you would pick and why, then what the choice turns on.
EOF
```

**The card is the whole message, written for someone who was not here.** The person answering knows the product and its people but did not follow this session: they read the card once, in their queue or on their phone, with nothing else open, and answer without opening the session. Name things the way they would. The names this work coined, its shorthand, and ids or references only the session explains (a task, a trigger, a script, "the rule from earlier") mean nothing to them, and neither does a pointer back to something said earlier in the session, their own words included: say what the thing is instead. The question is the choice as they would put it to themselves. Each option says what happens to the product or the people it reaches, then `::` and the fact that sizes it. The context opens on what you would pick and why, then gives only what the choice turns on: the finding that forces it, what cuts against your pick, and what you do meanwhile. It reads in a minute, under 150 words; how you got there and the supporting detail go in `--report report.html`. When the options are things to look at (layouts, mockups, drafts, charts), the person chooses by looking, so the card carries each picture: a `cast-canvas` in that option's `--option-body n=file.md`, or all of them side by side in a canvas after the context's opening. Draw them on the card rather than in your reply; a card that points back to a picture in the session leaves them choosing blind. Every number and claim on it is one the session established; an estimate says so. Before posting, read the card as that person: whatever they would have to ask you about, rewrite. After posting, don't repeat the options.

**A step only the person may take** (a grant, a spend, a pairing, an approval) is a permission ask, never a command to type: `cast decide "<what Yes does, in plain words>?" --run "cast …"` runs it as theirs on Yes (`--on laptop` from a cloud host). A refusal that posted an approval card has asked already: end your turn.

**Blocking is the default**: post, then end your turn; the answer arrives as a user message. `--advisory --default <n>` keeps you working on option n, but only when that default is cheap to undo. When facts change, `cast decide edit` rewrites your open decision in place and `cast decide cancel` withdraws one the work has moved past. `cast guide decide` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-decide -->
