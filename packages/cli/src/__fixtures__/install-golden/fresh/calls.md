
## Calls

Team huddles are transcribed with exact speaker attribution, and each call gets a title, summary and action items when it ends. `cast calls` shows what was decided, asked and owned without having been there.

```bash
cast calls                        # team call history, live calls first
cast call <id>                    # one call: summary + action items
cast call <id> --transcript       # full who-said-what transcript
cast call <id> --json             # machine-readable, segments too
cast call hold 3m|off             # hold the room's words while you work
```

When a task or thread refers to what was said on a call, read the transcript and quote the exact line rather than paraphrase it.
<!-- cast @VERSION@ -->
<!-- /codecast-calls -->
