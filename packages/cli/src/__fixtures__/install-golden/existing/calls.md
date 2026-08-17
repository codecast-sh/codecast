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

The team's huddles are transcribed with exact speaker attribution, and every call gets an
auto-generated title, summary and action items once it ends. `cast calls` is how you read
what was said without having been on the call — the decisions, the asks, who owns what.

```bash
cast calls                        # team call history, live calls first
cast call <id>                    # one call: summary + action items
cast call <id> --transcript       # full who-said-what transcript
cast call <id> --json             # machine-readable (includes segments)
```

Reach for a transcript when a task or thread refers to something "we discussed on the call",
and quote the exact line rather than paraphrasing from memory.
<!-- /codecast-calls -->
