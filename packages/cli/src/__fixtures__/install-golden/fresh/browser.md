
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

**Several steps at once**: `cast browser do` runs a whole flow in one invocation, which is far faster — most of a single command is process startup, not browser work. A step with no ref uses whatever the last `find` matched.

```bash
cast browser do "open example.com" "find Sign in" click "wait --text Password" shot
cast browser do - <<'EOF'          # one step per line, for longer flows
open https://example.com
find "Sign in"
click
type #e42 "hunter2" --submit
EOF
```

```bash
cast browser press Enter | Escape | "cmd+a" | "/"
cast browser scroll 800            # negative scrolls up, or --up
cast browser viewport mobile       # desktop|laptop|wide|tablet|mobile|mobile-small, or 1024x768
cast browser select #e3 "Option"   # native <select>
cast browser upload #e9 ./file.png # file input, no OS picker
cast browser hover #e5             # reveal a menu
cast browser wait --text "Saved"   # or --ref #e12, or plain settle
cast browser eval "location.href"  # JavaScript in the page
cast browser text                  # visible text, for reading rather than acting
```

**Debugging a web app**: `cast browser console` and `cast browser network --failed` report what the page logged and requested, including errors thrown before you looked. Modal dialogs never block you — `alert`/`confirm`/`prompt` are answered automatically and listed by `cast browser dialogs`, so a page that asks something cannot freeze the tab. Capture is armed automatically; when it starts after the page has already run it says so, and `cast browser reload` catches the whole load.

**Showing the human what you saw**: page-changing commands (open, click, submit, press, select, upload, reload) automatically put a small screenshot into the conversation when the page visibly changed, so a browsing thread documents itself — you do not need `shot` after every step. `cast browser shot` is still there for a deliberate full-size capture, under the command that took it. Add `--share` when you also want a link you can paste elsewhere, with `--alt` to caption it. Never link a local path — their browser cannot read files on this machine. `--no-shot` skips one automatic capture; `cast browser shots off` turns them off for good.

**Running the browser on another machine.** `cast browser start --remote linux` drives a Chrome on a cloud host instead of this one, and `cast browser hosts` lists what is available. Your logins come with you: the cookies for a site are decrypted here and injected into the remote browser as you navigate to it, so there is no list to configure and nothing of yours is stored there — the remote profile starts empty and is wiped on stop.

Two kinds of host, and the difference is mostly money:

- `--remote linux` — an EC2 instance. It sleeps when idle and then costs only its disk, about a dollar a month, and wakes in about thirty seconds when a command needs it. **Use this for anything web.** Chrome on Linux is the same Chrome speaking the same protocol.
- `--remote mac` — an Apple silicon Mac. It cannot sleep at all: Apple's licence imposes a 24-hour minimum lease, so it bills continuously (around EUR75/month) until deleted, and creating one per task is worse than leaving it up. **Only reach for it when the work genuinely needs macOS** — Xcode or an iOS build, the iOS simulator, or testing Safari specifically. A Mac is a shared pool, not a per-person machine.

Put a host back to sleep with `cast browser hosts sleep` when you are done; nothing else stops the meter.

**One browser, many agents.** Every agent on this machine drives the SAME Chrome window, and each session gets a tab of its own — `cast browser open <url>` reuses your tab, so just call it and keep working. `cast browser tabs` lists every tab and marks yours; you can see the others but you act only on your own. Reach for `--new-tab` only when you genuinely need a SECOND page open at once — opening one per step leaves a pile of tabs for everyone. In the conversation, each browser row carries an "open tab" pill that raises your live tab on the human's screen and a "watch live" pill that streams it, so the human can look whenever they like — nothing you do brings the browser to the front by itself.

The browser keeps running between commands, so this is stateful: what you opened stays open until you close it or run `cast browser stop`. It starts from a COPY of the real Chrome profile and, on every `open`, brings over the cookies the real Chrome holds for that site right now — so it is signed in to what the human is signed in to, including logins made after it started — and nothing it does touches the real browser. Treat that access the way the human would — it is their logged-in accounts. `cast browser start --fresh` gives a signed-out browser when that is what you want, and `cast browser stop --wipe` removes the copy.
<!-- /codecast-browser -->
