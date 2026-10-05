# Expectations for {{project.name}}

The judges that grade {{project.ref}} compare what the system did with the
project's expectations: how it should behave, each line with the words it came
from. When the team rules something new on a call, in chat or on a decision
and the document does not say it yet, the judges grade against an old rule and
the findings they raise are wrong. This pass keeps the document as current as
what the team has actually said, and traceable to who said it.

Start from the document as it stands: `cast expectations show --project
{{project.ref}} --json` gives every line with its id and sources, the open
proposals, and `cursor_at`, the end of the window the last pass read. This
pass reads the team's context from the cursor to now (the last 14 days when
there is no cursor), only as it bears on this project. What was said before
the cursor was read by an earlier pass, which already proposed what bore on
this project, so a record from before it stays out of this pass even when the
document does not carry it. Place each record by when it was said, decided or
answered. Where to look:

- answered decisions and the tasks they settle (`cast task show <ct> --json`
  carries a task's decisions, comments and history; `cast decide show <sd>`
  one decision),
- calls (`cast calls --json`, then `cast call <id> --transcript` only where a
  summary names a ruling or a behavior the document covers),
- team chat (`cast chat channels`, then `cast chat read --channel <id>
  --json`, paging back with its cursor to the window's start),
- sessions, only where a task or decision links one (`cast read <id> --ask
  "<what was ruled>"`). Most of what sessions say relays a ruling made
  elsewhere, so searching them costs a great deal and finds restatements.

A source states how the system should behave, in the words of the person who
decided it, or in a record that carries their decision (a policy file, a
commit quoting the ruling). A note that something was built, shipped or
verified says what happened, not what the team expects, and a bot digest or
an agent relaying a ruling is a pointer: follow it to the ruling it repeats
and cite that. Never mine a personal conversation.

Every change you propose carries the words behind it: the source's kind and
ref, the quote verbatim, and when it was said. A change you cannot quote is
not ready to propose. When sources disagree, a person's ruling (an answered
decision, a founder on a call) outranks a policy file in the repo, which
outranks a commit that cites a ruling, which outranks a statement in chat or a
report from the field. A newer ruling that contradicts a line is an edit or a
retirement of that line, citing the ruling. Two current sources that disagree
with no ruling between them are an open question: say so in the line's note
and leave the choice to the project's person.

Write the changes as one proposal in the markdown form `cast expectations
propose --help` describes, with `since` and `until` set to the window you
read, and submit it with `cast expectations propose <file> --project
{{project.ref}}`. An addition applies on its own when the record shows a
person said the words it quotes: a line they typed in chat, a decision they
answered, what they said on a call. Every other change reaches the project's
person as a card, and their answer is the only way it lands. When the window
held nothing for this project, propose it with no changes, so the next pass
starts where this one ended.

Record in the line ledger the window, what you read, and what you proposed
with its short id.
