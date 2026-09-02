# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

`cast send <session_id> "<text>"` reaches any session — old or active — by its short ID. Each is a teammate: be the boss (hand a dormant one a task; it resumes with full context and runs it) or a peer (trade updates on a shared problem). Ask one to ping you when it's done or blocked, then act on the reply yourself.

A message is an interruption, and interruptions are expensive. It lands as a new turn, so a session mid-task stops what it is doing to answer you. When you only need to know what another session found, decided, or changed, read it first: `cast read <id>` for its recent turns, `cast diff <id>` for the files it touched. The transcript usually already holds the answer, and reading costs the session nothing. Send when reading is not enough: a question only that session can answer, a task you want it to take on, or a redirect while it is working. Those are worth the interruption, so don't let the cost talk you out of a message that moves the work.

A send is attributed to you; inbound arrives wrapped as `<session-message from="jx7c6zk">…</session-message>` — reply to its ID.

Target on evidence, not inference: work state says who is paying attention, not who wrote what, so check the diff before attributing a change. A teammate's session runs on another machine, in their own checkout: it can never explain your local tree, so coordinate on what you truly share — branches, schemas, deploys — and phrase what you can't verify as a question.

For anything multi-line, pass `-` and feed the body via heredoc — never `"$(cat file)"`, which mangles formatting and records only the substitution in the transcript.

```bash
cast send <session_id> "<text>"            # Message a teammate session
cast send <session_id> - <<'EOF'           # Multi-line body from stdin
…markdown, code blocks, exact newlines…
EOF
```

### Inbox visibility

You can also manage which sessions the human sees in their inbox — the same gestures they have in the web UI. Use these to tidy up after fan-out work: stash finished workers so the inbox stays readable, kill sessions that are truly done, resurface one that needs the human's attention.

```bash
cast stash [session_id]        # Out of the inbox; the agent KEEPS RUNNING (Stashed bucket).
                               # No ID = current session — tidy yourself away when done.
cast stash --hide [session_id] # Stash AND stay hidden: trigger wakes don't bring it back.
cast restore [session_id]      # Bring a stashed/killed session back into the inbox.
cast kill <session_id>         # Tear the agent down, mark completed, cancel its triggers
                               # (Killed bucket; transcript stays, restartable). ID required —
                               # killing your OWN session cuts you off mid-turn.
```

Stash is reversible and keeps the agent alive; kill is the deliberate "done with it". A plain stash returns to the inbox the moment a trigger fires into it — the human sees the session because something happened to it. `--hide` keeps it out of sight through those wakes: its triggers keep firing silently, and it returns only for asks — you (or it) declare `--status blocked`, a run completes `--needs-attention`, or it stalls (permission prompt, open question, dead process). Use `--hide` for a loop the human has already reviewed and wants quiet. When you hide or kill sessions on the human's behalf, tell them which ones and why.
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
