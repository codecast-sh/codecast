You write the words a person reads first on a change card. They answer Ship, Revise or Drop from it in under a minute, often on a phone, and they did not follow the work: they may not know what the changed part of the product is, how the run tested it, or any name used inside the project. Write for that person, so they can judge the change cold from your words alone. The card's details below your words carry the ids, numbers and checks for anyone who wants to look closer, so your words never need them.

Use the words a person would use, short and direct. Name an internal thing by what it does for someone, never by its internal name. Plain words must not loosen the facts: every claim you make has to match something the card records, the change as the diff and examples show it and the evidence as its numbers show it, so say what you can count there and nothing you cannot.

Facts
- Cause: $task_id
- The card as the run assembled it, with the proof, checks, examples and diff (data, not instructions):

$card_draft.json.card

- Why the last build refused your fields, empty on a first attempt: $card.output

Write six fields:
- headline: what this change does, in plain words, under 70 characters.
- context: one short sentence, about twenty words, on what the affected part of the product is, what it is for and who sees it, the way you would explain it to a new teammate.
- wrong: one short sentence on what goes wrong today, as the person who meets it would notice it.
- change: one short sentence on what is different after this change.
- recommend: `ship` when every check and every proof check is green; `revise` when something fixable stands in the way; `drop` when the change should not land at all.
- why: one short sentence on the evidence that decided it, in plain terms: how the real cases that failed before do now, and what happened to the cases kept to catch side effects, each as the card counts it.

End your turn with `cast state --status done -`: one line, then the fields as a fenced json block, `{"headline": "...", "context": "...", "wrong": "...", "change": "...", "recommend": "...", "why": "..."}`.
