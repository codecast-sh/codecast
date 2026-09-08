
## Computer

`cast computer` drives a native macOS app through its accessibility tree: it reads one visible window as a compact indexed tree of text, acts on a single element by its index, and hands back a fresh tree. Reach for it when the work is in a desktop app — Slack, Spotify, Mail, System Settings, an installer, a native dialog — or when a browser window needs something the page itself cannot reach: the address field, a file picker, a permission sheet. For anything inside a web page, `cast browser` is the tool and stays the default; it holds the human's logins and speaks the page's own structure.

Accessibility and Screen Recording are granted by hand, once, to the codecast computer helper. Until the human does that, every verb fails saying so, and the fix takes three steps in this order. Read the grants with `cast computer permissions`: it reports and shows nothing on screen, so it is free to run at any time. If one is missing, hand the human `cast computer setup` and wait for them: it says what each missing permission allows and why the helper holds it, asks before anything appears, opens the pane for each one they still owe, and waits there until the grant lands. Then read the grants again to see what they did. Reading twice with no human in between changes nothing, and no amount of retrying grants anything.

```bash
cast computer capabilities                        # what this machine supports; sets the helper up on first run
cast computer setup                               # the human's one command for both grants; asks before it opens anything
cast computer permissions                         # read both grants; silent, nothing appears on screen
cast computer permissions --open-settings --id accessibility   # or --id screenshots; takes the front, so ask first
cast computer permissions --reset                 # clear both grants, for a stale deny that blocks a regrant
cast computer list-apps                           # bundle ids and pids of what is running
cast computer list-windows --app <app>            # the window id and index every other verb targets
cast computer get-app-state --app <app>           # one window as an indexed tree, plus a screenshot
cast computer click --app <app> --element-index 42
cast computer set-value --app <app> --element-index 42 --value "hello"
cast computer perform-secondary-action --app <app> --element-index 42 --action "open in new tab"
cast computer scroll --app <app> --direction down --element-index 42
cast computer type-text --app <app> --text "hello"
cast computer press-key --app <app> --key Return
cast computer hotkey --app <app> --key CmdOrCtrl+A
cast computer paste-text --app <app> --text "a long body"
```

`--app` takes a bundle id (`com.apple.TextEdit`), an app name (`TextEdit`) or `pid:1234`; prefer the bundle id, because names collide. Add `--window-id` or `--window-index` from `list-windows` when an app has several windows, and keep passing the same one until the target changes. Every verb takes `--json`, and every verb that touches a window also takes `--no-screenshot` and `--restore-window`. `cast computer help <verb>` prints that verb's flags from the binary that is about to run them — ask it rather than guessing, and rather than trusting a flag list you read anywhere else.

**The loop is read, act, read.** Snapshot with `get-app-state`, act on one element by the index the tree gave it, then read the fresh tree the action returns. Every action returns a full new snapshot, so you never need a separate state call between two steps.

**Indexes are sparse, and they go stale.** The tree drops noise, so the numbers have gaps: never infer an index from `elementCount`, and never count your way to one. An index is good only for the tree it came from. Navigation, scrolling, a focus change, a delay, or another agent driving the same window all invalidate it. A stale index fails as `element_not_found` rather than clicking whatever now sits at that number, so the failure is cheap and the fix is always the same: snapshot again.

**Read the verification apart from the success.** Exit 0 means the helper delivered the action, not that the app took it. Each action reports its own verdict: `verified` means the change was read back, and every other verdict names why it could not be — synthetic input, a clipboard paste, an accessibility action nobody asserted, or metadata an older helper never sent. Human output opens with `completed` only for a verified action and `attempted` for the rest; in `--json` the verdict is `action.verification`. When it says unverified and the result matters, run `get-app-state` and look.

**Prefer the verbs that leave the screen alone.** `set-value`, `perform-secondary-action`, and a click on an element that advertises a press all work on a window in the background: they take nothing from the human, and they are the ones that can be verified. Keyboard input is the opposite. `type-text`, `press-key`, `hotkey` and a click on a coordinate go to whatever is focused, so they need the target window frontmost already and otherwise fail with `window_not_focused`.

**No verb raises a window on its own.** Two flags move the human's screen and nothing else does: `--restore-window` brings a target window forward, and `--open-settings` brings System Settings forward. Pass either when they asked for it, or when the work genuinely cannot proceed without it, and not otherwise: everything else you do here is invisible to them, which is the point. `cast computer setup` opens the same panes, and it is theirs to run: it asks first, and with nobody at the keyboard to answer it opens nothing.

**Secrets never go on the command line.** `--text-stdin` for `type-text` and `paste-text`, `--value-stdin` for `set-value`. The payload arrives on stdin, so it stays out of shell history and out of every other user's `ps` output. Passing `--text` and `--text-stdin` together is an error, and so is asking for stdin when stdin is a terminal.

```bash
printf '%s' "$TOKEN" | cast computer set-value --app <app> --element-index 42 --value-stdin
```

**Password managers are refused.** 1Password, Bitwarden, Dashlane, LastPass, NordPass and Proton Pass answer `app_blocked` however you name them, and the helper enforces that, not the CLI. Any field that reads as a password, a passcode or a one time code renders as `[redacted]` in every tree; its real value never leaves the helper. When an app holds sensitive content, read only what you were asked to read.

**Modifiers are one flag, never two commands.** `click --modifiers CmdOrCtrl+Shift` holds them for that click alone. Never send a modifier down and a modifier up around something else: an agent interrupted between the two leaves a key logically held for the human. `press-key` takes exactly one key, `hotkey` takes a modifier and one key, and each says so when you mix them up. A paste above 16 MiB is refused rather than delivered, and `paste-text` puts the human's clipboard back when it is done.

**The behaviour rule.** Do not push, submit a form, send a message, buy anything, delete data, or change account settings unless the human asked for that action. Reading is yours to do; anything that leaves a mark is theirs to ask for.

**Coordinates are measured inside the window, not on the screen.** A screenshot on a retina display has more pixels than the window has points, so convert before you click: `action_x = screenshot_pixel_x / screenshot.scale`, taking the scale from that same capture. The snapshot header prints the division. Prefer an element index whenever the tree offers one.

**Every failure carries a code and its own recovery.** `--json` puts them in `code` and `recovery`; human output prints the recovery under the message. Read it and change something — never retry the same command unchanged.

| code | what to do about it |
| --- | --- |
| `app_not_found` | Nothing is running under that selector. List the apps and use the exact bundle id. A website is not a selector: target the browser that holds it. |
| `app_blocked` | A password manager, refused on purpose. Stop, and ask the human to do it. |
| `window_not_found` | No window matches. List the windows and target a listed one; `cast computer` never opens a closed app. |
| `window_not_focused` | Keyboard input needs the window frontmost. Ask once with `--restore-window`, or switch to `set-value`, which does not care. |
| `window_stale` | The window went away between the snapshot and the action. List the windows again, then take a fresh snapshot. |
| `element_not_found` | The index is stale, or was never in that tree. Take a fresh snapshot and use its numbers. |
| `element_not_clickable` | The element has no frame to click. Use a parent or a child that has one, or a coordinate. |
| `action_not_supported` | That name is not one this element advertises. Read its `Secondary Actions` in a fresh tree. |
| `value_not_settable` | The element takes no written value. Choose one that does, or focus it and type. |
| `invalid_argument` | The flags are wrong and the message says exactly how. Fix them; do not retry unchanged. |
| `permission_denied` | Accessibility is not granted, or the helper belongs to another launch. Read `cast computer permissions`. If the grant is missing, ask the human to run `cast computer setup`, or run `cast computer permissions --open-settings --id accessibility` once while they are there, then read again. A launch mismatch clears on a rerun. |
| `screenshot_failed` | The pixels are missing; the tree is not. Rerun with `--no-screenshot`. If the message names Screen Recording, ask the human to run `cast computer setup`, or run `cast computer permissions --open-settings --id screenshots` once while they are there, then read the grants again. |
| `action_timeout` | The helper did not answer in time. Snapshot first to see what changed, then try a simpler action. |
| `unsupported_capability` | This build or this platform cannot do it. Check `capabilities` and take another route. |
| `provider_incompatible` | The CLI and its helper come from different releases. Update codecast. |
| `accessibility_error` | The helper is missing, would not start, or died. Run `cast computer capabilities`. If the message names Accessibility, ask the human to run `cast computer setup`, or run `cast computer permissions --open-settings --id accessibility` once while they are there, then read the grants again. If it names the helper app, run `cast doctor`. |

Two conditions carry no code and still mean something. A tree that comes back empty with no screenshot usually means the app has no visible window, is minimized, or is missing a grant. And any message that mentions a permission means to read `cast computer permissions` before you try anything else — the read is silent and costs the human nothing, while granting is theirs alone and needs `--open-settings`.
<!-- cast @VERSION@ -->
<!-- /codecast-computer -->
