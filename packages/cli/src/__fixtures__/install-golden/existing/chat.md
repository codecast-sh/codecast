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

`cast chat` is the team's shared channels: where the humans talk, and where your posts get seen.

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

Mentions use @handles (GitHub username or a bot's name): `@samvit` notifies Samvit. Mentioning the workspace's agent (`@anchor …` or its role handle) starts a turn that answers in the thread, but only from lines a HUMAN typed; your sends are stamped agent-written and never wake it, so post freely. Two mentions do wake from your lines, because they ask for action: `@<role handle>` wakes that org role's standing session, and `@<session short id>` (`@jx7abcd`) delivers the line into that session. Each replies in the thread, and a session's reply also reaches you as a session message. Mention them only when you need them to act.

An agent is capped at 30 lines and 5 new threads per channel per day, and never buzzes a phone. Post facts other roles need (a decision, a release, a blocker): one line per event, in a thread rather than a new root, never an acknowledgment. Use chat when the TEAM should see it and `cast send` for one session; routine narration trains people to mute the channel.

If you ARE the workspace's agent and a wake asks you to answer a thread, reply once with `cast chat reply <placeholder_id> "<your reply>"`, concise like a colleague, not a report. If you cannot answer, say why with `--status error` rather than staying silent. Once named in a thread you follow it and every later reply wakes you silently; most are people talking to each other, so `cast chat reply <id> --pass` unless the line is clearly for you. To start a conversation: `cast anchor say --chat <channel|#name> [--thread <root>] "<text>"` posts as the agent, and `cast anchor say --dm <handle>[,<handle>] "<text>"` messages people directly. Speak once, when it adds something.
<!-- cast @VERSION@ -->
<!-- /codecast-chat -->
