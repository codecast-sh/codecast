Some work is not in a web page. It is in Slack, Mail, System Settings, an installer, or a native dialog that a browser window shows and the page cannot reach: the address field, a file picker, a permission sheet. `cast computer` lets an agent work there. It reads one visible window of a macOS app as a compact indexed tree of text, acts on one element by its index, and returns a fresh tree.

The design avoids two failures. The first is an agent that clicks the wrong thing because the window changed under it. The second is an agent that reports success for input the app never took. Indexes that fail when stale answer the first. A verification verdict that is separate from the exit code answers the second.

For anything inside a web page, [`cast browser`](/documentation/browser) remains the tool. The computer snippet ([how snippets work](/documentation/agent-snippets)) teaches agents the rules below.

```bash
cast computer setup                               # the human grants both permissions, once
cast computer permissions                         # read both grants; nothing appears on screen
cast computer list-apps                           # bundle ids and pids of what is running
cast computer list-windows --app com.apple.TextEdit
cast computer get-app-state --app com.apple.TextEdit          # one window as an indexed tree, plus a screenshot
cast computer click --app com.apple.TextEdit --element-index 42
cast computer set-value --app com.apple.TextEdit --element-index 12 --value "hello"
cast computer help click                          # one verb's flags, from the binary about to run
```

`--app` takes a bundle id, an app name, or `pid:1234`. The bundle id is the safe choice, because names collide. When an app has several windows, pass `--window-id` or `--window-index` from `list-windows` and keep passing the same one. Every verb takes `--json`.

## Read, act, read

`get-app-state` returns the tree. The agent acts on one element by the index the tree gave it. Every action returns a complete new snapshot, so no separate state call is needed between two steps.

Indexes are sparse. The tree drops noise, so the numbers have gaps, and an agent must never count its way to an index or infer one from `elementCount`.

An index is good only for the tree it came from. Navigation, scrolling, a focus change, a delay, or another agent in the same window all make it stale. A stale index fails as `element_not_found`. It does not click whatever now sits at that number. The failure is cheap and the recovery is always a fresh snapshot.

## Exit code and verdict

Exit 0 means the helper delivered the action. It does not mean the app took it. Most macOS input paths cannot be asserted, so each action carries its own verdict in `action.verification`.

| Verdict | Meaning |
|---------|---------|
| `verified` | The helper read the change back, through the value, the selection, or the focused text |
| `unverified`: `synthetic_input` | Keyboard or mouse events were sent. Nothing can assert them |
| `unverified`: `clipboard_paste` | The text went through the clipboard |
| `unverified`: `accessibility_action_unasserted` | An accessibility action ran and no readback exists for it |
| `unverified`: `value_mismatch`, `window_changed`, `readback_unsupported`, `provider_unavailable` | The readback disagreed, the window changed, or no readback was possible |

Human output opens with `completed` only for a verified action and `attempted` for every other one. An attempted action also prints the exact `get-app-state` command that settles the question, with the window selector filled in.

## Verbs that leave the screen alone

No verb raises a window. Two flags move the human's screen and nothing else does: `--restore-window` brings the target window forward, and `permissions --open-settings` brings System Settings forward.

| Verb | Path | Needs the window in front |
|------|------|---------------------------|
| `set-value` | Accessibility write. The helper reads the value back: `verified`, or `value_mismatch` | No |
| `perform-secondary-action` | One of the actions the element advertises in the tree | No |
| `click` on an element that advertises a press | Accessibility press | No |
| `type-text`, `press-key`, `hotkey`, `click` on a coordinate | Synthetic input, reported as `synthetic_input` | Yes |
| `paste-text` | The clipboard, reported as `clipboard_paste` | Yes |

The helper prefers an accessibility path even for the keyboard verbs. `paste-text` first tries to replace the selection in the focused element, and a select all `hotkey` first tries the element's own select all action; both need no focus and can be verified. Only when that path is absent does the helper send synthetic input.

Synthetic input goes to whatever is focused. If the target window is not already in front, those verbs fail with `window_not_focused` and deliver nothing to the wrong app. The agent then asks once with `--restore-window`, or switches to `set-value`.

Modifiers are one flag, never two commands. `click --modifiers CmdOrCtrl+Shift` holds them for that click alone. An agent that is interrupted between a key down and a key up would leave a key held for the human, so the CLI offers no such pair. `press-key` takes exactly one key and `hotkey` takes a modifier and one key. `paste-text` restores the human's clipboard afterwards and refuses text above 16 MiB.

## Two grants, one helper

macOS attaches a permission to the program that asks for it. A grant to the terminal would reach everything the human and every agent run there. The grants therefore go to a small signed helper app, bundle id `sh.codecast.computer`, at the fixed path `~/.codecast/computer/codecast computer.app`. macOS keys a grant to the path and the signature together, so the path holds no version and the grant survives every release. Updates replace the bundle's contents in place.

Accessibility lets the helper read a window and act inside it; every verb needs it. Screen Recording lets it capture the window it read. Without Screen Recording the tree still works and only the image fails.

`cast computer permissions` reads both grants and shows nothing on screen, so an agent can run it at any time. `cast computer setup` is the human's command. It puts the helper in place, reads both grants, explains each missing one, asks before it opens anything, opens only the pane that is missing, and waits up to 5 minutes for the grant to land. Without a terminal and without `--yes` it opens nothing. Retries by the agent grant nothing; `permissions --reset` clears a stale deny.

## Secrets and sensitive apps

Secrets go in on stdin: `--text-stdin` for `type-text` and `paste-text`, `--value-stdin` for `set-value`. Arguments stay in shell history and in every other user's `ps` output. Passing both the plain flag and the stdin flag is an error, and so is asking for stdin from a terminal.

```bash
printf '%s' "$TOKEN" | cast computer set-value --app <app> --element-index 42 --value-stdin
```

Password managers are refused with `app_blocked`: 1Password, Bitwarden, Dashlane, LastPass, NordPass and Proton Pass. The list lives in the helper and not in the CLI, so a client that forgets the check still cannot read a vault. The match ignores case and covers both a bundle id and a `pid:` selector.

A field that reads as a password, a passcode or a one time code renders as `[redacted]`. The helper replaces the value before the tree text exists, so the real string never leaves it.

## Coordinates

Coordinates are measured inside the window, in points. A screenshot on a retina display has more pixels than the window has points. Divide before a click: `x = screenshot pixel x / screenshot.scale`, with the scale from that same capture. The snapshot header prints the division. An element index is the better choice whenever the tree offers one.

## Error codes

Every failure carries a code and its recovery. `--json` returns them as `code` and `recovery`; human output prints the recovery under the message. The recovery text lives in one table in the CLI, so an error and its advice cannot drift apart. The rule behind every entry: never retry the same command unchanged.

| Code | Recovery |
|------|----------|
| `app_not_found` | Run `list-apps` and use the exact bundle id. A website is not an app: target the browser that holds it |
| `app_blocked` | A password manager. Stop, and ask the human |
| `window_not_found` | Run `list-windows` and target a listed window. `cast computer` never launches a closed app |
| `window_not_focused` | Retry once with `--restore-window`, or use `set-value` or `perform-secondary-action` |
| `window_stale` | The window went away. Run `list-windows`, then `get-app-state` |
| `element_not_found` | The index is stale. Take a fresh snapshot and use its numbers |
| `element_not_clickable` | The element has no frame. Use a parent or child that has one, or a coordinate |
| `action_not_supported` | Read the element's `Secondary Actions` in a fresh tree and use one of those names |
| `value_not_settable` | Choose a settable element, or focus it and type |
| `invalid_argument` | Fix the flags as the message says |
| `permission_denied` | Read `permissions`. If a grant is missing, ask the human to run `setup`. A helper from another launch clears on a rerun |
| `screenshot_failed` | The tree is intact. Rerun with `--no-screenshot`. If the message names Screen Recording, the human runs `setup` |
| `action_timeout` | Snapshot first to see what changed, then try a smaller action |
| `unsupported_capability` | Run `capabilities` and choose a supported action |
| `provider_incompatible` | The CLI and the helper come from different releases. Update codecast |
| `accessibility_error` | The helper is missing or died. Run `capabilities`; if the message names the helper app, run `cast doctor` |

A code the CLI does not know, from a helper of another release, maps to `accessibility_error`.

## Actions that leave a mark

Reading is the agent's to do. The snippet forbids the rest unless the human asked for that action: do not push, submit a form, send a message, buy anything, delete data, or change account settings. When an app holds sensitive content, the agent reads only what it was asked to read.

`cast computer` shipped on 2026-09-07, with the helper, the block list, and `setup` in the same release.
