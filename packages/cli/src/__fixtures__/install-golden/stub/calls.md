
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
