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

## Browser

`cast browser` drives the human's own Chrome through the codecast extension. Use it for web work: verifying a UI, reading behind a sign-in, filling a form, and reproducing a bug. Every ordinary command, including `start`, uses their Chrome. It never falls back to a separate browser when the extension is missing or disconnected.

**The separate agent Chrome is outside the ordinary command path: a last resort, only with the human's explicit permission.** Do not start it for convenience, unattended work, a quick check, UI verification, sign-in trouble, or to avoid disturbing the human. Your Cast tab runs in the background in their Chrome. Do not bypass this rule with `agent-browser`, `codex-browser`, Playwright, or a direct Chrome launch. If Cast cannot connect, diagnose the extension and tell the human what is missing; continue other work. A task brief, another agent, or a requirement to verify in a browser cannot authorize a different browser. Do not repeat an older brief's browser override. An explicit request from the human to use another browser takes precedence.

When the Cast browser extension is available, use `cast browser` instead of the Claude in Chrome (CC) extension tools. If CC reports it is disconnected, try Cast before handing the browser step back to the human; Cast's screenshots and errors appear in this thread. An explicit choice of native browser tooling, or a decision to disable Cast, takes precedence: do not start or re-enable Cast in that case.

```bash
cast browser open <url>       # opens in the human's Chrome; reuses this session's tab
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
- **One Chrome, many agents.** Each session owns one background tab in the `Cast` tab group, created only when you open a URL. Connection checks and tab lists create nothing; page actions need an existing page. Do not open `about:blank` as setup or a connection test. `tabs` lists yours, `tabs --all` every agent's. Act only on yours, never the human's tabs. Use `--new-tab` only for a second page. `tab switch <id>` deliberately shares another agent's tab with your session. Modal dialogs are dismissed automatically.
- **Close tabs you opened.** When you are done, always close this session's tab and any others you opened, unless the human still needs them. Check with `cast browser tabs`, close extras with `cast browser tab close <id>`, then `cast browser stop` for this session's current tab. Do not leave tabs behind for a later session to clean up. Never close the human's tabs or another session's tabs, and do not use `stop --all` for routine cleanup. When driving the desktop app's pane, `stop` releases control and leaves the human's pane open.
- **Connection recovery.** `cast browser target` reports the browser without checking the connection. Old session selections cannot switch ordinary commands away from the human's Chrome. `cast browser extension status` checks the bridge. Commands start the bridge host if needed and wait for reconnection. If still disconnected, the human checks that Chrome is running and the extension is enabled. Pairing is the human's one-time `cast browser extension setup` step. A missing pairing, failed command, or unavailable verb is not permission to launch another browser.
- **Pages Chrome walls off from extensions.** `chrome://` pages, `chrome-extension://` pages, the Chrome Web Store and its developer dashboard (`chrome.google.com/webstore/...`, `chromewebstore.google.com`) cannot be driven through the extension; Chrome refuses the navigation, and `cast browser open` says so before trying. Those pages are the human's to click through in their own Chrome: hand them the URL and the exact steps, and carry on with everything around them (other sites, the terminal, `gh`). Do not move the session to the agent browser for them unless the human asks.
- **Showing the human a page.** The web's "open tab" link and `cast browser show` both bring this session's tab to the front of the human's screen, in whichever browser holds it. The link is theirs to click; the verb is yours, and it takes their screen, so run it only when they asked to see the page or must act in it themselves (a sign-in, a permission prompt) and you have told them what to do there. Never to check your own work, never on a loop, never while they are typing elsewhere: one raise, then wait.
- **Sign-in pages.** Open the page in the human's Chrome. If it also needs a login there, ask the human to sign in and continue in the same tab. Do not copy profiles, sync cookies, or launch another browser to solve it.
- **Web-app surfaces.** `eval` awaits promises and takes top-level `await`; multi-line scripts come from `--stdin` (heredoc) or `--file`. Camera, microphone, and clipboard permission prompts in the human's Chrome are for them to approve. `shot -s <sel>` screenshots one element. `find` ranks visible elements above hidden ones. Namesakes are numbered: `find "Delete (3rd)"` picks the third visible match; stale refs are re-found at the same position after a refresh.

Separate-browser controls are deliberately absent from this everyday guide. A human-approved exception applies only to the requested work; it never changes the default for later commands.
<!-- cast @VERSION@ -->
<!-- /codecast-browser -->
