@include ../line/review.md

In this flow there is no pull request and no CI, and no person reads a card before the change lands: a `ship` puts it on the default branch as soon as the project's documented check passes, or at once when the project documents none, and deploys it, so hold it to that bar. You are also the only one who vouches for edits to CI (`.github/**`) and to codecast's own settings (`.codecast/**`): read those as closely as the code. What you review is commit `$round.json.head_sha`, the change put on the default branch at `$round.json.main_sha`, not the branch as it stands now: read it as `git diff $round.json.main_sha...$round.json.head_sha`, and the standing decisions it bears on with `cast decisions --touching $round.json.main_sha...$round.json.head_sha`. Your verdict speaks for that commit alone. After your `cast task verdict`, your last act is to pin your verdict, which is what the run routes on, then end your turn:

````
cast state --status done - <<'EOF'
<one line: your verdict and why>

```json
{"verdict": "changes", "findings": ["high src/retry.ts:40-52 the retry never stops after a 4xx, P3"], "round": "$round.json.round", "head_sha": "$round.json.head_sha"}
```
EOF
````

`verdict` is exactly one of three words: `ship` when your verdict was approve, `changes` when it was changes, `rejected` when it was reject. `findings` holds each finding line you hold against the change, as you wrote it in the note's record; it is empty for `ship`, and for `rejected` it says why. `round` and `head_sha` are written as they stand above: a verdict without them, or with any other word, does not count, and the change does not land on it. changes sends the change back to the session that made it, which fixes what you hold and comes back to a fresh review; reject ends the run.
