# The Verdicts station (personal.cast): one line saying what this round found.
# The graph routes on the check's and the reviewer's JSON; this is the line a
# person reads on the card and the session reads in its brief.
check="$check.json.outcome"
verdict="$review.json.verdict"
case "$check" in pass|fail|skipped) ;; *) check="did not run" ;; esac
case "$verdict" in ship|changes|rejected) ;; *) verdict="none" ;; esac
[ "$review.json.round" = "$round.json.round" ] || verdict="none for this round"
echo "check $check, review $verdict"
