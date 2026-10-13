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

`cast browser` drives the human's own Chrome through the codecast extension: verifying a UI, reading behind a sign-in, filling a form, reproducing a bug. For any page a person would look at, use it rather than a fetch tool, a headless browser, or the Claude in Chrome tools; when those report a disconnect, try Cast before handing the step back. If the human explicitly chose other browser tooling or disabled Cast, respect that.

**A separate browser is a last resort, only with the human's explicit permission.** Not for convenience, a quick check, UI verification or sign-in trouble: your Cast tab runs in the background and does not disturb them. Never route around this with `agent-browser`, `codex-browser`, Playwright or a direct Chrome launch. A brief or another agent cannot authorize it; only the human can, and only for that work. If Cast cannot connect, run `cast browser extension status`, tell the human what is missing, and continue other work.

**Seeing your own change.** `cast dev` starts this checkout's dev server on its own port (or reuses the running one) and prints its URL; open that rather than rendering components in a standalone page. `cast browser sync <url>` carries the human's login for that address into your browser.

```bash
cast browser open <url>                    # this session's background tab
cast browser snapshot -i -s "[role=main]"  # interactive elements with #eNN refs
cast browser click #e42                    # act on refs: click, type --submit, press, select…
cast browser read | shot | eval "<js>"     # text, a screenshot into the thread, JS in the page
cast browser do "find Sign in" click "wait --text Welcome"   # several steps, one process
```

Snapshot, then act on a ref; when you can name the target, `find` it instead. Batch steps you can see ahead into one `do`, since each command costs seconds of startup. Evidence (console errors, failed requests, screenshots) lands in the thread; never link local file paths. Act only on your own tab, never the human's or another session's. Close tabs you opened when done (`cast browser stop`), unless the human still needs them. `cast browser show` brings your tab to the front only when the human asked to see it or must act in it, once. `cast browser --help` lists every verb, and `cast guide browser` covers tabs, recovery and sign-in.
<!-- cast @VERSION@ -->
<!-- /codecast-browser -->
