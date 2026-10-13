
## Team chat

`cast chat` is the team's shared channels: where the humans talk, and where your posts get seen. Use it when the team should see something, and `cast send` for one session.

```bash
cast chat channels                                         # the team's channels, with unread counts
cast chat read --channel <id> [--since 2h]
cast chat send --channel <id> [--thread <root_id>] "<text>"
cast chat search "<query>"
```

Post facts other people need (a decision, a release, a blocker): one line per event, in a thread rather than a new root, never an acknowledgment. An agent is capped at 30 lines and 5 new threads per channel per day, and routine narration trains people to mute the channel. Mentions use @handles: `@<role handle>` wakes that role's standing session and `@<session short id>` delivers the line into that session, so mention them only when you need them to act. If you are the workspace's agent answering a wake, `cast guide chat` covers `cast chat reply` and `cast anchor say`.
<!-- cast @VERSION@ -->
<!-- /codecast-chat -->
