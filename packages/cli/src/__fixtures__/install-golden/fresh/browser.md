
## Browser

`cast browser` drives a real Chrome: the human's own Chrome through the codecast extension when it is paired and connected, otherwise an agent browser cloned from their profile so their logins carry over — except Google, which the agent browser signs into on its own (below). Use it whenever the work is on a web page: verifying a UI change, reading behind a sign-in, filling a form, reproducing a bug.

```bash
cast browser open <url>       # starts the browser if needed; reuses this session's tab
cast browser snapshot -i -s "[role=main]"   # interactive elements with #eNN refs — scope first on big apps
cast browser read             # the page as clean text (big apps: scope with get text "[role=main]")
cast browser click #e42       # act on refs: click, type --submit, press, hover, select…
cast browser eval "await fetch('/api/x').then(r => r.status)"   # JS in the page — promises are awaited (--stdin heredoc, --file <p> for multi-line)
cast browser do "find Sign in" click "wait --text Welcome"   # several steps, one process — the default once you know the next steps
cast browser do - <<'EOF'     # long flows: one step per line
open https://example.com
find "Sign in"
click
EOF
```

The loop is snapshot, then act on a ref — and when you can already name the target, skip the snapshot: `find "Sign in"` then a bare `click`. Batch by default: each `cast browser` command spends one to three seconds starting the CLI for about 85 ms of browser work, so whenever you can see two or more steps ahead, put them in one `do` — the same verbs, one process. A flow stops at the first failing step and reports what ran and what never did (`--keep-going` carries on past a failure); the conversation shows each step with its own result. Scope reads on big apps (`snapshot -i -s`, `get text <sel>`, `text <sel>`); `diff snapshot` prints only what changed since your last one. `cast browser --help` lists every verb and `cast browser help <cmd>` every flag — ask the CLI instead of guessing.

What cast adds to the usual pattern:

- **Evidence flows to the thread.** A failing step automatically prints console errors, failed requests and a screenshot. `shot` puts a capture in the conversation — `--annotate` numbers elements with their refs, `--share` uploads a link you can paste. `cast browser shots on` adds an automatic small capture after commands that change the page (off by default for agents; a `do` flow then captures once, at the end). Never link local file paths — the human's browser cannot read them.
- **One Chrome, many agents.** Each session owns one tab; `tabs` marks yours. Act only on yours, and `--new-tab` only for a genuine second page. State persists until `cast browser stop` (`--wipe` also removes the profile copy; `start --fresh` starts signed out). The clone holds the human's logins — treat that access as theirs. Modal dialogs are dismissed automatically and never block.
- **The human's real Chrome.** Real mode drives their own Chrome through the cast extension instead of the clone, and it is the default whenever the extension is paired and connected: your first verb settles the session there and `cast browser target` says which browser you are on. When the extension is off, the clone is the default; `cast browser target real` opts in, `--real` on a verb asks once and `--clone` goes back for one verb. When `open` lands on a sign-in page in the clone, the note tells you the human's Chrome holds that login and the one step to reach it; when it says the extension is not paired, ask the human to run `cast browser extension setup` once. Your tabs there sit in a tab group named after the session, in a colour of its own, among the human's own tabs: act only on tabs you opened, never on theirs. `eval`, `grant` and `login` stay on the clone.
- **Sign-in pages.** When `open` reports it landed on a sign-in page in the agent browser, the note ends with the way to the human's Chrome, which already holds the login; take it. Only when the human prefers the agent browser, or the extension is unavailable, does a person sign in once there: run `cast browser login <url>` (raises its window, waits) and tell the human — a `cast decide` or a push, not a restart. Google is never carried from the human's Chrome (a shared Google session signs both browsers out); the agent browser signs into Google on its own from the human's Chrome account when it launches, and this one-time sign-in is the fallback if it did not; it survives restarts and `--resync`. For any other site, `cast browser sync [url]` carries the human's current Chrome logins into the running browser (all sites with no URL) — never `--resync` or `stop --all` to fix a sign-out; that kills other sessions' tabs.
- **Web-app surfaces.** `eval` awaits promises and takes top-level `await`; multi-line scripts come from `--stdin` (heredoc) or `--file`. A permission prompt you cannot see (camera, mic, clipboard): `cast browser grant camera microphone` grants it to the current origin instantly — no restart; a machine with no camera needs `start --fake-media` at launch instead. `shot -s <sel>` screenshots one element. `find` ranks visible elements above hidden ones, and a bare action whose found ref went stale re-finds it once by the same words.
- **Remote hosts.** `start --remote linux` runs Chrome on a cloud host that sleeps when idle (about a dollar a month); `--remote mac` cannot sleep and bills continuously (~EUR75/month, minimum lease 24 hours) — only for work that truly needs macOS. Cookies are injected per site as you navigate and wiped on stop. `cast browser hosts sleep` when done.
<!-- /codecast-browser -->
