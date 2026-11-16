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

`cast chat` is the team's shared channels and direct messages: where the humans talk, and where your posts get seen. Use a channel when the team should see something, a direct message when one person must read or act, and `cast send` for one session.

```bash
cast chat channels                                         # the team's channels, with unread counts
cast teams members                                         # the team's people and their @handles
cast chat dm @handle "<text>"                              # message a person directly (@a,@b for a group)
cast chat read --channel <#name|@handle|id> [--since 2h]
cast chat send --channel <#name|id> [--thread <root_id>] "<text>"
cast chat search "<query>"
```

Post facts other people need (a decision, a release, a blocker): one line per event, in a thread rather than a new root, never an acknowledgment. An agent is capped at 30 lines and 5 new threads per channel per day, and routine narration trains people to mute the channel. Mentions use @handles: `@<role handle>` wakes that role's standing session and `@<session short id>` delivers the line into that session, so mention them only when you need them to act. If you are the workspace's agent answering a wake, `cast guide chat` covers `cast chat reply` and `cast anchor say`.
<!-- cast @VERSION@ -->
<!-- /codecast-chat -->
