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

## Team chat

`cast chat` is the team's shared channel space — where the humans talk, and where you can post
progress they will actually see. A channel like #releases that sessions report into is one
command; reading what the team said this morning is another.

```bash
cast chat channels                          # the team's channels, with unread counts
cast chat read --channel <id>               # read one, newest last
cast chat read --channel <id> --since 2h    # only what landed since: one short line each, oldest first
cast chat send --channel <id> "<text>"      # post (markdown renders; ct-/pl- ids become live pills)
cast chat send --channel <id> --thread <root_id> "<text>"   # reply on a thread
cast chat thread <root_id>                  # one thread: root + replies
cast chat search "<query>"                  # full-text search across the team's chat
cast chat react <message_id> <emoji>        # toggle a reaction
```

Mentions use @handles (github username, or a bot's name) — `@samvit` notifies Samvit.
Mentioning the workspace's agent (`@anchor …`, or its role handle) starts an agent turn that answers IN the thread —
but only for lines a HUMAN typed: your sends are stamped as agent-written and never wake it, so
post freely. Two mentions DO wake from your lines, because they ask for that party's action:
`@<role handle>` wakes an org role's standing session and `@<session short id>` (`@jx7abcd`)
delivers the line into that session; each replies in the thread, and a session's reply comes
back to you as a session message. Mention a role or a session only when you need it to act.

An agent's lines are capped: 30 per channel per day, 5 new threads per channel per day, and
they never buzz a phone. Post facts other roles need (a decision, a release, a blocker), one
line per event, in a thread rather than a new root, and never an acknowledgment.

If you ARE the workspace's agent and a wake asks you to answer a thread, reply with
`cast chat reply <placeholder_id> "<your reply>"` — one concise answer, like a colleague in
chat, not a report. If you cannot answer, say why with `--status error` instead of staying
silent. Once named in a thread you follow it: every later reply wakes you silently, and most
of those lines are people talking to each other — `cast chat reply <id> --pass` unless the
line is clearly for you. You can also start conversations yourself: `cast anchor say --chat
<channel|#name> [--thread <root>] "<text>"` posts as the agent, `cast anchor say --dm
<handle>[,<handle>] "<text>"` messages people directly. Speak when it adds something, once.

Post to chat when the TEAM should see it (a release landed, a deploy finished, a decision is
needed); use `cast send` for a message to one specific session. Don't narrate routine work into
a channel — a channel full of agent noise trains people to mute it.
<!-- cast @VERSION@ -->
<!-- /codecast-chat -->
