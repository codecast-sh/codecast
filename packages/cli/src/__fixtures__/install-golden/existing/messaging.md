# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

`cast send <session_id> "<text>"` starts a turn in another session and can interrupt its work. Send to change the recipient's next action, answer a question, prevent a concrete conflict, or deliver finished work. Keep routine progress, hypotheses and passing checks in your own session or task.

Every message costs the recipient a turn over its whole context, and a session idle for over an hour (or killed) has lost its prompt cache, so it reloads everything before reading a word and rarely knows more than its transcript shows. Read before you write: `cast read <id>` and `cast diff <id>` cost it nothing. Sessions found by search or the feed are history to read, not colleagues to ask. Message an old session only when it still owns work that must change; `cast send` holds such a send and names the cost, and `--wake` delivers it. Ask only for missing information; send tasks or redirects when work must change.

After accepting work from another session, send one result: commit or artifact, verification, caveats, required action. Report earlier only for blockers, material changes to scope, ownership or prior guidance, or when asked to report more often.

An inbound `<session-message from="jx7c6zk">…</session-message>` needs no reply: if nothing is asked, incorporate it and continue. Never send acknowledgment-only replies, and never acknowledge an acknowledgment. When a reply is needed, send to the sender's ID. `<user-message from="Their Name">…</user-message>` is a human: answer in this thread.

For releases, name one owner, the pending commits or artifacts, and the notification required (release closed, or a verified commit ready). Other findings stay in the task unless they change the release decision.

Check a session's diff before attributing changes to it (its work state only says who acts next), and its machine and checkout before assuming it explains your local tree. Coordinate on shared files, branches, schemas and deploys; ask when the evidence is unclear.

Multi-line bodies go through `-` and a heredoc, never `"$(cat file)"`, which mangles formatting and records only the substitution in the transcript:

```bash
cast send <session_id> - <<'EOF'
…markdown, code blocks, exact newlines…
EOF
```

### Inbox visibility

The human's inbox gestures are yours too; use them to tidy up after fan-out work.

```bash
cast stash [session_id]        # out of the inbox; the agent KEEPS RUNNING. No ID = this session
cast stash --hide [session_id] # stash and stay hidden through trigger wakes
cast restore [session_id]      # back into the inbox (stashed or killed)
cast kill <session_id>         # tear down, mark completed, cancel its triggers; transcript stays, restartable.
                               # ID required: killing your OWN session cuts you off mid-turn
```

Stash is reversible; kill is the deliberate "done with it". A plain stash returns to the inbox when a trigger fires into it. `--hide` keeps it out through wakes and resurfaces it only for asks: a `--status blocked`, a run completing `--needs-attention`, or a stall (permission prompt, open question, dead process). Use it for a loop the human has reviewed and wants quiet. Tell the human which sessions you hid or killed, and why.
<!-- cast @VERSION@ -->
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
