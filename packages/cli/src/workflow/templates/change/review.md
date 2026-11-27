@include ../line/review.md

In this flow you review beside CI on the change's pull request, and no person reads a card before it merges: a `ship` merges the change as soon as CI is green, so hold it to that bar. The one card a person may read here comes only once CI is green on this head, so your card says nothing about CI: never that it is unchecked, failing or still running. What you review is the pull request's head, commit `$pr.json.head_sha`, not the branch as it stands now: read it as `git diff $default_branch...$pr.json.head_sha`, after `git fetch origin $branch` if your checkout lacks that commit. Your verdict speaks for that commit alone. After your `cast task verdict`, your last acts are to record your verdict on the run and pin it, which is what the run routes on, then end your turn:

````
cast flow review-verdict --verdict changes --head "$pr.json.head_sha" --round "$pr.json.round"
cast state --status done - <<'EOF'
<one line: your verdict and why>

```json
{"verdict": "changes", "findings": ["high src/retry.ts:40-52 the retry never stops after a 4xx, P3"], "round": "$pr.json.round", "head_sha": "$pr.json.head_sha"}
```
EOF
````

`verdict` is exactly one of three words, the same in both: `ship` when your verdict was approve, `changes` when it was changes, `rejected` when it was reject. `findings` holds each finding line you hold against the branch, as you wrote it in the note's record; it is empty for `ship`, and for `rejected` it says why. `round` and `head_sha` are written as they stand above: a verdict without them, or with any other word, does not count, and the change does not merge on it.
