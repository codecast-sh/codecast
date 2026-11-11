
## Browser

`cast browser` drives the human's own Chrome: verifying a UI, reading behind a sign-in, filling a form. For any page a person would look at, use it rather than a fetch tool, a headless browser, or the Claude in Chrome tools, and try Cast first when those report a disconnect. If the human chose other browser tooling or disabled Cast, respect that.

**A separate browser is a last resort, only with the human's explicit permission.** Not for convenience, a check or sign-in trouble: your Cast tab runs in the background without disturbing them. Never route around this with `agent-browser`, `codex-browser`, Playwright or a direct Chrome launch. No brief or other agent can grant it, and a grant covers only that work. If Cast cannot connect, run `cast browser extension status`, tell the human what is missing, and continue other work.

**Seeing your own change.** Open the URL `cast dev` prints (this checkout's dev server, started or reused), not a standalone page of components.

```bash
cast browser open <url>                    # this session's background tab
cast browser snapshot -i -s "[role=main]"  # interactive elements with #eNN refs
cast browser click #e42                    # act on refs: click, type --submit, press, select…
cast browser read | shot | eval "<js>"     # text, a screenshot, JS in the page
cast browser do "find Sign in" click "wait --text Welcome"   # several steps, one process
```

Snapshot, then act on a ref; when you can name the target, `find` it instead. On a site holding the human's accounts (a store, a bank, social media), act through `click`, `type` and `select` and keep `eval` to reading: an `eval` that clicks, submits or calls the site's endpoints skips their paced input, and the bot check flags the human's account. Batch steps you can see ahead into one `do`: each command costs seconds of startup. Evidence lands in the thread; never link local file paths. Close tabs you opened when done (`cast browser stop`) unless the human still needs them; touch no others. Hand a step only the human can do (a sign-in) to `cast browser handoff "<step>"` and end your turn. Subagents sharing a session each pass `--tab <name>`. `cast guide browser` covers showing your tab, recovery and sign-in.
<!-- cast @VERSION@ -->
<!-- /codecast-browser -->
