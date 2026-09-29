
## Computer

`cast computer` drives a native macOS app through its accessibility tree: it reads one visible window as an indexed text tree, acts on one element by its index, and returns a fresh tree. Use it for desktop apps (Slack, Spotify, Mail, System Settings, an installer, a native dialog) and for what a web page cannot reach in its browser window: the address field, a file picker, a permission sheet. Inside a web page, `cast browser` is the tool and stays the default; it holds the human's logins and speaks the page's own structure.

**Grants.** Accessibility and Screen Recording are granted by hand, once, to the codecast computer helper; until then every verb fails saying so. Read the grants with `cast computer permissions`, which shows nothing on screen and is free to run anytime. If one is missing, hand the human `cast computer setup` and wait: it explains each permission, asks before anything appears, opens each pane they still owe and waits for the grant. Then read again. Rereading with no human in between, or retrying, grants nothing.

```bash
cast computer capabilities                        # what this machine supports; sets the helper up on first run
cast computer setup                               # the human's one command for both grants; asks before it opens anything
cast computer permissions                         # read both grants; silent
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

`--app` takes a bundle id (`com.apple.TextEdit`, preferred because names collide), an app name, or `pid:1234`. For an app with several windows add `--window-id` or `--window-index` from `list-windows`, and keep passing it until the target changes. Every verb takes `--json`; verbs that touch a window also take `--no-screenshot` and `--restore-window`. `cast computer help <verb>` prints the flags of the binary about to run them; trust it over any list you read elsewhere.

**Read, act, read.** Snapshot with `get-app-state` and act on one element by its index. Every action returns a full new snapshot, so no state call is needed between steps.

**Indexes are sparse, and they go stale.** The tree drops noise, so never infer an index from `elementCount` or count your way to one. An index is good only for the tree it came from; navigation, scrolling, a focus change, a delay, or another agent in the window invalidates it. A stale index fails as `element_not_found` rather than clicking whatever sits there now, so the fix is always to snapshot again.

**Success is not verification.** Exit 0 means the helper delivered the action, not that the app took it. `verified` means the change was read back; any other verdict names why it could not be (synthetic input, a clipboard paste, an unasserted accessibility action, an older helper). Human output opens `completed` only when verified and `attempted` otherwise; in `--json` it is `action.verification`. When unverified and it matters, run `get-app-state` and look.

**Prefer verbs that leave the screen alone.** `set-value`, `perform-secondary-action` and a click on an element that advertises a press work on a background window, take nothing from the human, and can be verified. `type-text`, `press-key`, `hotkey` and coordinate clicks go to whatever is focused, so they need the target window frontmost and otherwise fail with `window_not_focused`.

**No verb raises a window on its own.** Only `--restore-window` (the target window) and `--open-settings` (System Settings) move the human's screen; pass them only when asked, or when the work genuinely cannot proceed otherwise. `cast computer setup` opens the same panes but is theirs to run: it asks first and, with nobody at the keyboard, opens nothing.

**Secrets never go on the command line.** Use `--text-stdin` for `type-text` and `paste-text`, and `--value-stdin` for `set-value`, so the payload stays out of shell history and `ps`. `--text` with `--text-stdin`, or stdin from a terminal, is an error.

```bash
printf '%s' "$TOKEN" | cast computer set-value --app <app> --element-index 42 --value-stdin
```

**Password managers are refused.** 1Password, Bitwarden, Dashlane, LastPass, NordPass and Proton Pass answer `app_blocked` under any name, enforced by the helper. A password, passcode or one time code field renders as `[redacted]` in every tree. In an app holding sensitive content, read only what you were asked to read.

**Modifiers are one flag, never two commands.** `click --modifiers CmdOrCtrl+Shift` holds them for that click alone; a separate down and up leaves a key held for the human if you are interrupted between them. `press-key` takes exactly one key, `hotkey` a modifier and one key. A paste above 16 MiB is refused, and `paste-text` restores the human's clipboard afterwards.

**The behaviour rule.** Do not push, submit a form, send a message, buy anything, delete data, or change account settings unless the human asked for that action. Reading is yours to do; anything that leaves a mark is theirs to ask for.

**Coordinates are window points, not screen pixels.** Convert from a retina screenshot with `action_x = screenshot_pixel_x / screenshot.scale`, using that capture's scale (the snapshot header prints the division). Prefer an element index whenever the tree offers one.

**Every failure carries a code and its recovery** (`code` and `recovery` in `--json`, printed under the message otherwise). Change something before retrying; never rerun unchanged.

| code | what to do about it |
| --- | --- |
| `app_not_found` | Nothing runs under that selector. Use the exact bundle id from `list-apps`; for a website, target the browser holding it. |
| `app_blocked` | A password manager, refused on purpose. Stop, and ask the human to do it. |
| `window_not_found` | No window matches. Target one from `list-windows`; nothing here opens a closed app. |
| `window_not_focused` | Keyboard input needs the window frontmost. Ask once with `--restore-window`, or use `set-value`, which does not care. |
| `window_stale` | The window went away between snapshot and action. List the windows again, then snapshot. |
| `element_not_found` | The index is stale, or was never in that tree. Snapshot again and use its numbers. |
| `element_not_clickable` | No frame to click. Use a parent or child that has one, or a coordinate. |
| `action_not_supported` | The element does not advertise that action. Read its `Secondary Actions` in a fresh tree. |
| `value_not_settable` | The element takes no written value. Pick one that does, or focus it and type. |
| `invalid_argument` | The message says exactly which flags are wrong. Fix them; do not retry unchanged. |
| `permission_denied` | Accessibility is missing, or the helper belongs to another launch (a rerun clears that). Read `cast computer permissions`; if the grant is missing, ask the human to run `cast computer setup`, or run `cast computer permissions --open-settings --id accessibility` once while they are there, then read again. |
| `screenshot_failed` | The pixels are missing, the tree is not: rerun with `--no-screenshot`. If it names Screen Recording, ask the human to run `cast computer setup`, or run `cast computer permissions --open-settings --id screenshots` once while they are there, then read again. |
| `action_timeout` | No answer in time. Snapshot to see what changed, then try a simpler action. |
| `unsupported_capability` | This build or platform cannot do it. Check `capabilities` and take another route. |
| `provider_incompatible` | The CLI and its helper come from different releases. Update codecast. |
| `accessibility_error` | The helper is missing, would not start, or died. Run `cast computer capabilities`. If it names Accessibility, ask the human to run `cast computer setup`, or run `cast computer permissions --open-settings --id accessibility` once while they are there, then read again. If it names the helper app, run `cast doctor`. |

Without a code: an empty tree with no screenshot usually means no visible window, a minimized app, or a missing grant. Any message mentioning a permission means read `cast computer permissions` before anything else; granting is the human's alone.
<!-- cast @VERSION@ -->
<!-- /codecast-computer -->
