# Finder health for {{project.name}}

A declared finder that stops filing makes {{project.ref}} look healthier than
it is, and nobody notices until the problem it watched for reaches a customer.
This pass checks that every finder the profile declares is still listening.

Read the declared finders with `cast line profile --json` from
{{project.dir}}, and each one's newest signal with `cast signal ls --project
{{project.ref}} --source <its source>`. A finder is silent when its newest
signal is older than its window: {{input.finders.silent_days}} days, or one
full interval of its own schedule when its `runs` line says it runs less
often than that, plus a day of slack. A finder that has never filed is silent
from the day it was declared.

For each silent finder, file one signal into the project with `cast signal
add`: source `org_health`, kind `regression`, fingerprint
`finder-silent:<finder id>` so every day of the same silence counts toward one
cause, a title naming the finder and since when, and a detail saying where the
finder runs and what its last signal was. Do not try to restart or repair the
finder in this pass; the cause carries that work through the line.

Record in the line ledger each finder with its newest signal and verdict. When
every finder is filing, record that in one line and stop.
