
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
