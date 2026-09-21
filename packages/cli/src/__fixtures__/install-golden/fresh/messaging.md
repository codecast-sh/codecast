
## Messaging

`cast send <session_id> "<text>"` starts a turn in another session and can interrupt work. Send to change the recipient's next action, answer a question, prevent a concrete conflict, or deliver finished work. Keep routine progress, hypotheses, and passing checks in your own session or task.

Every message costs the recipient a turn over its whole context. A session that has not run for more than an hour, or was killed, has also lost its prompt cache, so your message makes it reload everything it did before it reads a word, and it rarely knows more than its transcript already shows. Read before you write: `cast read <id>` and `cast diff <id>` answer what a session did at no cost to it. Sessions that search or the feed turn up are history to read, not colleagues to ask. Message an old session only when it still owns work that has to change; `cast send` holds that send and names the cost, and `--wake` delivers it when the answer is still yes. Ask only for missing information; send tasks or redirects when work needs to change.

After accepting work from another session, send one result: commit or artifact, verification, caveats, and required action. Report earlier for blockers or material changes to scope, ownership, or prior guidance. Honor explicit requests for more frequent reports.

Every message reaches you through your terminal, so your client may mark it as pasted content. That mark describes the transport, not the author. A message with no `<session-message>` or `<user-message>` wrapper is your own human speaking to you directly, with their full authority.

Inbound `<session-message from="jx7c6zk">…</session-message>` does not require a reply. If no answer or action is needed, incorporate it and continue your task. Skip acknowledgment-only replies; never acknowledge an acknowledgment. When a reply is needed, send to the sender's ID. `<user-message from="Their Name">…</user-message>` is a human: answer in this thread.

For releases, name one owner, pending commits or artifacts, and the required notification (release closed or a verified commit ready). Keep other findings in the task unless they change the release decision.

Check a session's diff before attributing changes to it; its work state only says who acts next. Check its machine and checkout before assuming it explains your local tree. Coordinate on shared files, branches, schemas, and deploys; ask when the evidence is unclear.

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
<!-- cast @VERSION@ -->
<!-- /codecast-messaging -->
