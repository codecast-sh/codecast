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

## Computer

`cast computer` drives a native macOS app through its accessibility tree: it reads one window as an indexed tree, acts on one element by name or index, and reports what the action changed. Use it for desktop apps (Notes, Slack, Mail, System Settings, an installer, a native dialog) and for what a web page cannot reach in its browser window (the address field, a file picker, a permission sheet), rather than AppleScript or reading an app's files directly. Inside a web page, `cast browser` stays the tool.

```bash
cast computer list-apps                           # bundle ids of what is running
cast computer get-app-state --app <app>           # one window as an indexed tree, plus a screenshot
cast computer find --app <app> "Sign"             # only the matching elements
cast computer click --app <app> --element "Save"  # by name (or --element-index N); several matches are listed, never guessed
cast computer do --app <app> - <<'EOF'            # several steps in one process
click "Sign"
wait "Created"
EOF
```

Other verbs: `set-value`, `type-text`, `paste-text`, `press-key`, `hotkey`, `scroll`, `drag`, `wait`, `perform-secondary-action`. `--app` takes a bundle id (preferred), an app name, or `pid:1234`.

**Read once, then act and read the change.** Every action prints what it changed, with the indexes to use next, so no snapshot is needed between steps; "No change" means the app ignored it. An index is good only for the tree it came from: after navigation, scrolling or a delay, snapshot again. Exit 0 means the action was delivered, not that the app took it; it is confirmed only when it says `verified`.

**The human keeps their screen.** Every verb works on a background window, and none raises one unless you pass `--restore-window`; do that only when asked, or when only a real mouse event will do. Accessibility and Screen Recording grants are the human's to give: when a verb says one is missing, read `cast computer permissions` and hand them `cast computer setup`.

Secrets go through `--text-stdin` or `--value-stdin`, never the command line. Password managers are refused on purpose. Do not submit a form, send a message, buy, delete or change settings unless the human asked for that action; reading is yours to do. Every failure prints its code and the recovery: change something before retrying. `cast computer help <verb>` lists a verb's flags, and `cast guide computer` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-computer -->
