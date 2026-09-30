
## Computer

`cast computer` drives a native macOS app through its accessibility tree: it reads one visible window as an indexed text tree, acts on one element by name or index, and reports what the action changed. Use it for desktop apps (Slack, Spotify, Mail, System Settings, an installer, a native dialog) and for what a web page cannot reach in its browser window: the address field, a file picker, a permission sheet. Inside a web page, `cast browser` is the tool and stays the default; it holds the human's logins and speaks the page's own structure.

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
cast computer find --app <app> "Sign"             # only the matching elements, with their ancestors
cast computer click --app <app> --element "Save"  # by name; several matches are listed, never guessed
cast computer click --app <app> --element-index 42 --mouse   # a real click at its center, for a control that ignores the press
cast computer wait --app <app> "Created"          # until text appears (--gone, --change, --timeout)
cast computer drag --app <app> --x 470 --y 650 --to-x 230 --to-y 130   # press, move, release (window in front)
cast computer set-value --app <app> --element-index 42 --value "hello"
cast computer perform-secondary-action --app <app> --element-index 42 --action "open in new tab"
cast computer scroll --app <app> --direction down --element-index 42
cast computer type-text --app <app> --text "hello"
cast computer press-key --app <app> --key Return
cast computer hotkey --app <app> --key CmdOrCtrl+A
cast computer paste-text --app <app> --text "a long body"
cast computer do --app <app> - <<'EOF'            # many steps, one process
click "Sign"
wait "Created"
action "insert signature" "Created January 27"
shot
EOF
```

`--app` takes a bundle id (`com.apple.TextEdit`, preferred because names collide), an app name, or `pid:1234`. For an app with several windows add `--window-id` or `--window-index` from `list-windows`, and keep passing it until the target changes. Every verb takes `--json`; verbs that touch a window also take `--find`/`--under` to print part of the tree, and `--restore-window`. `get-app-state` captures a screenshot unless `--no-screenshot`; an action captures only with `--screenshot`. `cast computer help <verb>` prints the flags of the binary about to run them; trust it over any list you read elsewhere.

**Read once, then act and read the change.** Take one snapshot (or `find` what you need), then act by name with `--element` or by index. Every action prints what it changed in the window's tree, with the indexes to use next, so no snapshot is needed between steps; "No change" means the app ignored it. `get-app-state --diff` shows what changed since your last read. **Batch by default**: each command pays one to three seconds of CLI startup, so put the steps you can see ahead into one `do`; it stops at the first failing step (`--keep-going` continues) and `cast computer help do` lists its step forms.

**Indexes are sparse, and they go stale.** The tree drops noise, so never infer an index from `elementCount` or count your way to one. An index is good only for the tree it came from; navigation, scrolling, a focus change, a delay, or another agent in the window invalidates it. A stale index fails as `element_not_found` rather than clicking whatever sits there now, so the fix is always to snapshot again.

**Success is not verification.** Exit 0 means the helper delivered the action, not that the app took it. `verified` means the change was read back; any other verdict names why it could not be (synthetic input, a clipboard paste, an unasserted accessibility action, an older helper). Human output opens `completed` only when verified and `attempted` otherwise; in `--json` it is `action.verification`. When unverified and it matters, read the change it printed, or take a screenshot.

**The human keeps their screen.** Every verb works on a background window. `set-value`, `perform-secondary-action` and a click on an element that advertises a press go through accessibility and can be verified. Keys and typing go to the target app's own event queue when it is not frontmost, so they reach that app and never the one the human is using. A coordinate click on a background window presses the control under that point through accessibility. A real mouse event (`--mouse`, `drag`, a control with no press) needs the window in front, because macOS drops a press on a background window; look for a route without the mouse first, and use `--restore-window` when only the mouse will do. The human's pointer returns to where it was after every real mouse event.

**The agent cursor.** Every action that lands on a point shows an orange "agent" pointer gliding there and pulsing on the press, drawn over the screen without taking focus, so the human can see what you are doing. `--no-cursor` hides it for one action.

**No verb raises a window on its own.** Only `--restore-window` (the target window) and `--open-settings` (System Settings) move the human's screen; pass them only when asked, or when the work genuinely cannot proceed otherwise. `cast computer setup` opens the same panes but is theirs to run: it asks first and, with nobody at the keyboard, opens nothing.

**Secrets never go on the command line.** Use `--text-stdin` for `type-text` and `paste-text`, and `--value-stdin` for `set-value`, so the payload stays out of shell history and `ps`. `--text` with `--text-stdin`, or stdin from a terminal, is an error.

```bash
printf '%s' "$TOKEN" | cast computer set-value --app <app> --element-index 42 --value-stdin
```

**Password managers are refused.** 1Password, Bitwarden, Dashlane, LastPass, NordPass and Proton Pass answer `app_blocked` under any name, enforced by the helper. A password, passcode or one time code field renders as `[redacted]` in every tree. In an app holding sensitive content, read only what you were asked to read.

**Modifiers are one flag, never two commands.** `click --modifiers CmdOrCtrl+Shift` holds them for that click alone; a separate down and up leaves a key held for the human if you are interrupted between them. `press-key` takes exactly one key, `hotkey` a modifier and one key. A paste above 16 MiB is refused, and `paste-text` restores the human's clipboard afterwards.

**The behaviour rule.** Do not push, submit a form, send a message, buy anything, delete data, or change account settings unless the human asked for that action. Reading is yours to do; anything that leaves a mark is theirs to ask for.

**Coordinates are window points.** Screenshots are point sized, so a position read off one is the coordinate an action takes (`--json` carries element frames too). Prefer an element whenever the tree offers one.

**Every failure carries a code and its recovery** (`code` and `recovery` in `--json`, printed under the message otherwise). Change something before retrying; never rerun unchanged.

| code | what to do about it |
| --- | --- |
| `app_not_found` | Nothing runs under that selector. Use the exact bundle id from `list-apps`; for a website, target the browser holding it. |
| `app_blocked` | A password manager, refused on purpose. Stop, and ask the human to do it. |
| `window_not_found` | No window matches. Target one from `list-windows`; nothing here opens a closed app. |
| `window_not_focused` | A mouse click or drag needs the window in front. Use the accessibility route (click by element without `--mouse`, `perform-secondary-action`), or `--restore-window` when only the mouse will do. |
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
