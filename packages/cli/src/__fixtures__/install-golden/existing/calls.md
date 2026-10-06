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

Team huddles are transcribed with exact speaker attribution, and each call gets a title, summary and action items when it ends. When a task or thread refers to what was said on a call, read it and cite the words rather than paraphrase them.

```bash
cast calls                        # team call history, live calls first
cast call <id>                    # one call: summary + action items, and which lines were filmed
cast call <id> --transcript       # full who-said-what transcript, each line labeled cl-42:15
cast call snap cl-42:15           # a recorded call's screen when line 15 was said, as a PNG to read
```

`cl-42:15-25` on its own line renders those lines with their speakers. When the words point at something on screen ("this button", "the second chart"), snap that moment and read it before acting on it. `cast guide calls` covers frames, crops and live calls.
<!-- cast @VERSION@ -->
<!-- /codecast-calls -->
