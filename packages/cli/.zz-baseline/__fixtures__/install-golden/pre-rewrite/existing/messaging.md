# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

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

## Messaging

`cast send <session_id> "<text>"` reaches any session — old or active — by its short ID. Each is a teammate: be the boss (hand a dormant one a task; it resumes with full context and runs it) or a peer (trade updates on a shared problem). Ask one to ping you when it's done or blocked, then act on the reply yourself. Collaboration is the default, but interruptions aren't free — use judgment.

It lands as a new turn attributed to you; inbound arrives wrapped as `<session-message from="jx7c6zk">…</session-message>` — reply to its ID.

Target on evidence, not inference: `cast diff <id>` lists the files a session actually changed, `cast read <id>` shows what it is doing now — work state says who is paying attention, not who wrote what. A teammate's session runs on another machine, in their own checkout: it can never explain your local tree, so coordinate on what you truly share — branches, schemas, deploys — and phrase what you can't verify as a question.

For anything multi-line, pass `-` and feed the body via heredoc — never `"$(cat file)"`, which mangles formatting and records only the substitution in the transcript.

```bash
cast send <session_id> "<text>"            # Message a teammate session
cast send <session_id> - <<'EOF'           # Multi-line body from stdin
…markdown, code blocks, exact newlines…
EOF
```

### Inbox visibility

You can also manage which sessions the human sees in their inbox — the same gestures they have in the web UI. Use these to tidy up after fan-out work: dismiss finished workers so the inbox stays readable, kill sessions that are truly done, resurface one that needs the human's attention.

```bash
cast dismiss [session_id]      # Hide from the inbox; the agent KEEPS RUNNING (Stashed bucket).
                               # No ID = current session — tidy yourself away when done.
cast undismiss [session_id]    # Bring a dismissed/killed session back into the inbox.
cast kill <session_id>         # Tear the agent down, mark completed, cancel its schedules
                               # (Killed bucket; transcript stays, restartable). ID required —
                               # killing your OWN session cuts you off mid-turn.
```

Dismiss is reversible and keeps the agent alive; kill is the deliberate "done with it". When you hide or kill sessions on the human's behalf, tell them which ones and why.
<!-- /codecast-messaging -->
