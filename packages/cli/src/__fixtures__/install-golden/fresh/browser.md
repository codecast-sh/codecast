
## Browser

`cast browser` drives a real Chrome, cloned from the human's profile so their logins carry over. Use it whenever the work is on a web page: verifying a UI change, reading behind a sign-in, filling a form, reproducing a bug.

```bash
cast browser open <url>       # starts the browser if needed; reuses this session's tab
cast browser snapshot -i -s "[role=main]"   # interactive elements with #eNN refs — scope first on big apps
cast browser read             # the page as clean text (big apps: scope with get text "[role=main]")
cast browser click #e42       # act on refs: click, type --submit, press, hover, select…
cast browser do "find Sign in" click "wait --text Welcome"   # several steps, one invocation (`do -` reads steps from stdin)
```

The loop is snapshot, then act on a ref — and when you can already name the target, skip the snapshot: `find "Sign in"` then a bare `click`. Scope reads on big apps (`snapshot -i -s`, `get text <sel>`, `text <sel>`); `diff snapshot` prints only what changed since your last one. `cast browser --help` lists every verb and `cast browser help <cmd>` every flag — ask the CLI instead of guessing.

What cast adds to the usual pattern:

- **Evidence flows to the thread.** A failing step automatically prints console errors, failed requests and a screenshot. `shot` puts a capture in the conversation — `--annotate` numbers elements with their refs, `--share` uploads a link you can paste. `cast browser shots on` adds an automatic small capture after commands that change the page (off by default for agents; a `do` flow then captures once, at the end). Never link local file paths — the human's browser cannot read them.
- **One Chrome, many agents.** Each session owns one tab; `tabs` marks yours. Act only on yours, and `--new-tab` only for a genuine second page. State persists until `cast browser stop` (`--wipe` also removes the profile copy; `start --fresh` starts signed out). The clone holds the human's logins — treat that access as theirs. Modal dialogs are dismissed automatically and never block.
- **Remote hosts.** `start --remote linux` runs Chrome on a cloud host that sleeps when idle (about a dollar a month); `--remote mac` cannot sleep and bills continuously (~EUR75/month, minimum lease 24 hours) — only for work that truly needs macOS. Cookies are injected per site as you navigate and wiped on stop. `cast browser hosts sleep` when done.
<!-- /codecast-browser -->
