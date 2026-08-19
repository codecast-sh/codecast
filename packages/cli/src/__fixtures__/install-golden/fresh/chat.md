
## Team chat

`cast chat` is the team's shared channel space — where the humans talk, and where you can post
progress they will actually see. A channel like #releases that sessions report into is one
command; reading what the team said this morning is another.

```bash
cast chat channels                          # the team's channels, with unread counts
cast chat read --channel <id>               # read one, newest last
cast chat send --channel <id> "<text>"      # post (markdown renders; ct-/pl- ids become live pills)
cast chat send --channel <id> --thread <root_id> "<text>"   # reply on a thread
cast chat thread <root_id>                  # one thread: root + replies
cast chat search "<query>"                  # full-text search across the team's chat
cast chat react <message_id> <emoji>        # toggle a reaction
```

Mentions use @handles (github username, or a bot's name) — `@samvit` notifies Samvit.
Mentioning the team's anchor (`@anchor …`) starts an agent turn that answers IN the thread —
but only for lines a HUMAN typed: your sends are stamped as agent-written and never wake it, so
post freely.

If you ARE the anchor and a wake asks you to answer a thread, reply with
`cast chat reply <placeholder_id> "<your reply>"` — one concise answer, like a colleague in
chat, not a report. If you cannot answer, say why with `--status error` instead of staying
silent. Once named in a thread you follow it: every later reply wakes you silently, and most
of those lines are people talking to each other — `cast chat reply <id> --pass` unless the
line is clearly for you. You can also start conversations yourself: `cast anchor say --chat
<channel|#name> [--thread <root>] "<text>"` posts as the anchor, `cast anchor say --dm
<handle>[,<handle>] "<text>"` messages people directly. Speak when it adds something, once.

Post to chat when the TEAM should see it (a release landed, a deploy finished, a decision is
needed); use `cast send` for a message to one specific session. Don't narrate routine work into
a channel — a channel full of agent noise trains people to mute it.
<!-- /codecast-chat -->
