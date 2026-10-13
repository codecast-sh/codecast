
## Messaging

`cast send <session_id> "<text>"` starts a turn in another codecast session and can interrupt its work; your harness's own messaging tool does not reach those sessions. Send to change the recipient's next action, answer a question, prevent a concrete conflict, or deliver finished work. Keep routine progress, hypotheses and passing checks in your own session or task.

Every message costs the recipient a turn over its whole context. Read before you write: `cast read <id>` and `cast diff <id>` cost it nothing. Sessions found by search or the feed are history to read, not colleagues to ask; message an old session only when it still owns work that must change.

After accepting work from another session, send one result: commit or artifact, verification, caveats, required action. Report earlier only for blockers or material changes. An inbound `<session-message from="…">` needs no reply unless it asks something; never send acknowledgment-only replies. A `<user-message from="…">` is a human: answer in this thread.

Check a session's diff before attributing changes to it, and its machine and checkout before assuming it explains your local tree. Multi-line bodies go through `cast send <id> - <<'EOF'`, never `"$(cat file)"`.

After fan-out work, tidy the human's inbox: `cast stash [id]` takes a session out of it while it keeps running (`--hide` keeps it out through trigger wakes), `cast restore [id]` brings one back, and `cast kill <id>` is the deliberate "done with it" (always name the id: killing your own session cuts you off mid-turn). Tell the human which sessions you hid or killed, and why. `cast guide messaging` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-messaging -->
