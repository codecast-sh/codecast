# Weekly fix loop for {{project.name}}

Every fix this week is evidence about an earlier change: the lines it removed
or rewrote were written by some commit, in some session, under some run of the
line and some role. Tracing that back is how the line learns which of its runs
produce the defects it later pays for, and which role's work keeps coming back.

Run the trace from {{project.dir}}, which does the git work for you:

  cast line fixloop --since 7d --json

It picks the week's fix commits (a commit on a bug task, in a change story of
kind fix, or with a subject starting `fix:` or `fix(`, which is a naming
convention and says so), blames the lines each fix changed at the fix's parent
revision, and resolves every introducing commit to its session, its line run
and its role. The plain form prints the same as a table with a per role rollup.

Read each trace before you believe it. A fix that rewrote a line from a
refactor two months ago is not a regression of that refactor; a fix that undid
what a run shipped days earlier is. Confirm a regression when the introducing
commit's own change caused what the fix repairs, by reading both diffs. For
each confirmed regression file one signal through the door, so the line reopens
or files the cause through its normal path and the health board counts it
against the role whose run introduced it:

  cast signal add --kind regression --fingerprint szz:<introducing sha> \
    --title "<what the fix repaired> introduced by <introducing sha short>" \
    --role <the introducing role's handle, when the trace names one> \
    --detail "<fix sha, introducing sha, session, run, the days between, and why you are sure>"

The fingerprint is the introducing sha, so a second fix of the same bad change
next week counts toward the same cause instead of opening another. Record in
the line ledger the rollup per role (fixes traced, introducing commits, lines),
how many traces you confirmed and how many you set aside, and the signal and
cause each reached. A week with no fix commits is a result too: say so, and say
whether the trace could see the sessions at all, because an empty week and a
checkout with no Codecast-Session trailers look the same.
