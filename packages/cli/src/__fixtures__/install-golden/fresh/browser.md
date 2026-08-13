
## Browser

`cast browser` drives a real Chrome — the same browser you use, cloned so it keeps your logins. Use it whenever the work is on a web page: verifying a UI change you just made, reading a page behind a sign-in, filling a form, reproducing a bug with the console in hand.

```bash
cast browser start                 # clone the last-used Chrome profile and launch (once per machine)
cast browser open <url>            # navigate, waiting for the page to finish rendering
cast browser snapshot              # the page as text, with #eNN refs on everything actionable
cast browser click #e42            # click a ref  (--force to click through an overlay)
cast browser type #e7 "text" --submit
cast browser find "Sign in"        # locate a ref by its visible name
```

The loop is **snapshot, then act on a ref**. A snapshot prints the page's accessibility tree — every button, link and field with a `#eNN` handle — which is far cheaper and more precise than a screenshot. Refs stay valid as long as the element does, so you do not need a fresh snapshot after every click; take one when the page has changed shape. Actions report where they landed and whether the page navigated, so you rarely need a second call to find out what happened.

```bash
cast browser press Enter | Escape | "cmd+a" | "/"
cast browser scroll 800            # negative scrolls up
cast browser select #e3 "Option"   # native <select>
cast browser upload #e9 ./file.png # file input, no OS picker
cast browser hover #e5             # reveal a menu
cast browser wait --text "Saved"   # or --ref #e12, or plain settle
cast browser eval "location.href"  # JavaScript in the page
cast browser text                  # visible text, for reading rather than acting
```

**Debugging a web app**: `cast browser console` and `cast browser network --failed` report what the page logged and requested, including errors thrown before you looked. Capture is armed automatically; when it starts after the page has already run it says so, and `cast browser reload` catches the whole load.

**Showing the human what you saw**: `cast browser shot` puts the picture straight into the conversation, under the command that took it — no flag needed. Add `--share` when you also want a link you can paste elsewhere, with `--alt` to caption it. Never link a local path — their browser cannot read files on this machine.

**One browser, many agents.** Every agent on this machine drives the SAME Chrome, so tabs are owned per session: commands act on YOUR tab, and `cast browser tabs` marks it `*` and other agents' tabs `~`. Open your own with `cast browser open --new-tab <url>` and pass `--tab <id>` when you want to be certain. If a page suddenly looks wrong, run `cast browser tabs` before you debug the app — a tab someone else navigated looks exactly like a broken feature.

The browser keeps running between commands, so this is stateful: what you opened stays open until you close it or run `cast browser stop`. It starts from a COPY of the real Chrome profile, so it is signed in to what you are signed in to, and nothing it does touches the real browser. Treat that access the way the human would — it is their logged-in accounts. `cast browser start --fresh` gives a signed-out browser when that is what you want, and `cast browser stop --wipe` removes the copy.
<!-- /codecast-browser -->
