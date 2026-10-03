
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
cast call snap cl-42 15           # the same, the moment as its own word
cast call snap cl-42@12:34        # the frame 12m34s in (also @754s)
cast call snap cl-42:15-25        # a frame each time the shared screen changed across lines 15 to 25
cast call snap cl-42:15 --crop top-left   # part of the frame at full size (also --tiles 2x2), for small text
```

When a task or thread refers to what was said on a call, read the transcript and cite the words rather than paraphrase them. A call's short ID with a line range, `cl-42:15-25`, renders as those lines with their speakers when it stands on its own line, and as a pill inline.

A recorded call keeps its video, with each screen share at full resolution. `cast call <id>` says which lines were filmed, and its transcript prints each line's time with ▸ on the filmed ones, so snap those. When the words point at something on screen ("this button", "the second chart"), snap the moment and read the PNG before acting on it. Each frame prints with the line being said and its citation, `cl-42@12:34`, which on its own line in a message renders as that same picture for anyone who can read the call; that citation is how to show a frame. Each frame also prints its size: a wide screen is shrunk before you read it, so when its text is too small, snap again with `--crop` (a named part such as `top-left`, or x,y,w,h) or `--tiles 2x2`. `--share` makes a frame a public image, so use it only when the human asks to show one to someone outside codecast. A snap writes lines with a colon and a time with `@`, so `cl-42:12:34` could be either and is refused with both spellings. While a call is recording, the stretch still being recorded has only its live picture (`cast call snap cl-42`) until Record is stopped; stretches already saved can be snapped at once.
<!-- cast @VERSION@ -->
<!-- /codecast-calls -->
