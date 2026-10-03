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

## Calls

Team huddles are transcribed with exact speaker attribution, and each call gets a title, summary and action items when it ends. `cast calls` shows what was decided, asked and owned without having been there.

```bash
cast calls                        # team call history, live calls first
cast call <id>                    # one call: summary + action items
cast call <id> --transcript       # full who-said-what transcript, each line labeled with its cl-42:15 reference
cast call <id> 15:25              # just lines 15 to 25
cast call <id> --json             # machine-readable, segments too
cast call hold 3m|off             # hold the room's words while you work
cast call cl-42@12:34             # the lines being said at 12m34s
cast call snap cl-42:15           # a recorded call's frame when line 15 was said, as a PNG to read
cast call snap cl-42@12:34        # the frame 12m34s in
cast call snap cl-42:15-25        # a frame each time the shared screen changed across lines 15 to 25
```

When a task or thread refers to what was said on a call, read the transcript and cite the words rather than paraphrase them. A call's short ID with a line range, `cl-42:15-25`, renders as those lines with their speakers when it stands on its own line, and as a pill inline.

A recorded call keeps its video, with each screen share at full resolution, and `cast call <id>` says which stretches were filmed. When the words point at something on screen ("this button", "the second chart"), snap the moment and read the PNG before acting on it. Each frame prints with the line being said and its citation, `cl-42@12:34`, which on its own line in a message renders as that same picture for anyone who can read the call; that citation is how to show a frame. `--share` makes a frame a public image, so use it only when the human asks to show one to someone outside codecast. While a call is still recording only its live picture can be snapped, and earlier moments become available once Record is stopped.
<!-- cast @VERSION@ -->
<!-- /codecast-calls -->
