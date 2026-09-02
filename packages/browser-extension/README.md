# Codecast browser bridge

Drive tabs in your **real** Chrome from `cast browser`: your logins, your
session, no profile clone. The cloned browser stays the default for
unattended work. The bridge is for work you want to watch in your own
browser, and for sites that fight a fresh profile.

```
cast CLI ──ws──▶ bridge host (127.0.0.1, token proven both ways) ◀──ws── this extension ──chrome.debugger──▶ your tabs
```

The host presents itself as a Chrome DevTools endpoint. The browser engine
and every `cast browser` verb (snapshot refs, clicks, typing, screenshots)
work the same way against the real Chrome. Only the transport differs.

## Install (about 3 minutes, nothing to paste)

1. In Chrome, open `chrome://extensions`, turn on **Developer mode** (top
   right), click **Load unpacked**, and select this directory
   (`packages/browser-extension`).
2. In a terminal: `cast browser extension setup`. It starts the bridge host
   on this machine and, on macOS, opens the extension's options page in
   Chrome with the token and port already filled in. The page saves them,
   clears them from the address bar, and connects. The command waits up to
   ten seconds for that connection and prints one line when it arrives:
   `extension connected`. Only when it does not arrive does the command print
   the install steps.
3. Check any time with `cast browser extension status`: two green lines, one
   for the host and one for the extension.

If step 2 did not open the page (another OS, Chrome was not found, or macOS
asked whether the terminal may control Chrome and you said no), run
`cast browser extension setup --show-token`. It prints the pairing URL to
open by hand, plus the token and port to enter under **Details, Extension
options** followed by **Save & connect**. Without `--show-token` the command
never prints the token: these commands run inside agent sessions whose output
syncs off the machine. `--json` follows the same rule (`--json --show-token`
includes the token and the URL).

The token rides in the URL fragment. A fragment never leaves the browser, and
`options.js` removes it from the address bar as soon as it has read it, so
the token does not linger in history or in a screenshot. On macOS the URL
reaches Chrome through `osascript` on stdin, never as a process argument,
because every user on a Mac can read every other user's process arguments.
The first run may show a macOS prompt asking whether your terminal may
control Google Chrome.

Chrome warns that the extension can use the debugger API. That is the point:
`chrome.debugger` is what lets cast drive tabs.

## The extension ID is stable, and the private key is gone

The pairing URL works because the extension has the same ID on every
machine: `dfimhlggoaabdefnfhlpboehapdaakol`. Chrome names an unpacked
extension after its install path unless the manifest carries a `key`, so
`manifest.json` holds a committed public key and Chrome derives the ID from
it (SHA-256 of the DER key, first 32 hex characters, each digit mapped from
0 to f onto the letters a to p). `extensionIdOfKey` in
`packages/cli/src/browser/bridge/protocol.ts` is that rule, and the constant
`BRIDGE_EXTENSION_ID` next to it is what the CLI uses. `protocol.test.ts`
checks that the constant agrees with the manifest.

The matching private key was deleted after generation. An unpacked load reads
only the public half, and nothing in this workflow signs a `.crx`. A private
key we kept would be a secret with no use and one more thing to leak. To
change the key, generate a new pair with `openssl genrsa 2048` and
`openssl rsa -pubout -outform DER`, base64 the DER, update `key` in the
manifest and `BRIDGE_EXTENSION_ID`, and delete the private key again.

## Use

```bash
cast browser target real                       # verbs act on your real Chrome for this session
cast browser open https://example.com          # opens the session's own tab in your Chrome
cast browser snapshot -i                       # every verb works as it does against the clone
cast browser tabs                              # this session's tabs; the rest are yours
cast browser open --real https://example.com   # or ask for the real Chrome on one verb
cast browser snapshot --clone                  # --clone overrides a sticky real for one verb
cast browser target                            # prints the current choice
```

`target real` is sticky per session; `clone` is the default. Real mode is a
second engine session, keyed `<session>-real`, on the bridge port. A session
can therefore hold a tab in each browser without the two colliding.

Rules the CLI enforces in real mode:

- A session acts only on a tab it opened, or one you name with `--tab`. It
  never touches your other tabs, and it never falls back to a free tab.
  Without a session id (a human at a bare shell) the CLI picks an existing
  tab.
- The session's tab opens in the background. Focus stays where you had it.
- `cast browser stop` closes the session's tab. The reaper closes it the
  same way when the session ends.
- `grant`, `eval` and `login` drive the clone only: the extension cannot
  grant site permissions in your Chrome, and the other two have no real mode
  path yet. Asked for the real Chrome, they refuse before anything opens a
  tab there.

## What you see while a session drives a tab

- **A coloured Chrome tab group** named `cast <session>` (the first seven
  characters of the session id; a session known only by its tmux pane is
  named `cast pane <n>`). The colour is chosen from the session id, so two
  agents in the same Chrome get different colours and the same agent gets the
  same colour on every run. Every tab the session opens joins the group. The
  extension remembers which groups it created and touches only those: a
  group you made yourself is never renamed, animated or adopted by a session.
  While a session works the title shows cycling dots; CDP calls that arrive
  within 600 ms of each other count as one span, the dots start once a span
  has run for 300 ms, and a checkmark follows for three seconds when the span
  ends. The frames have a fixed width so the tab strip does not shift. The
  group disappears with its last tab.
- **A thin border** around the driven page, in the group's colour. It takes
  no clicks, and the extension hides it for every screenshot, so captures
  show the page alone. The extension injects it through the debugger
  session it already holds, so it needs no host permission and no content
  script, and it runs its script in an isolated world with a random element
  id: the page cannot reach the script, cannot watch for the moment before a
  screenshot, and cannot write a stylesheet rule against the element in
  advance. (The DOM is shared, so a hostile page can still remove the
  element; Chrome's infobar and the tab group are not the page's to touch.)
  It goes away when the session detaches. The extension also refreshes a
  heartbeat in the page every three seconds, and the border hides itself
  when eight seconds pass with none, so cancelling the debugger yourself, or
  a crashed host, cannot leave the frame behind.
- **The codecast icon in the toolbar.** Click it for a small popup: the
  connection in one line, the tabs a session holds right now under their
  group names (click one to show it), and Reconnect and Settings buttons.
  The settings page (the same one pairing opens) explains all of this with
  live status and keeps the pair by hand form for the rare machine where
  setup cannot open Chrome.
- **Chrome's own infobar:** *"Codecast" started debugging this
  browser*. Chrome shows it for as long as any tab is attached. **Cancel**
  detaches at once; the extension notices and lets the tab go. An extension
  cannot suppress this infobar. The only ways around it are to launch Chrome
  with `--silent-debugger-extension-api`, or to install the extension through
  an enterprise force install policy. Neither is part of this workflow.

## Security posture

- **What the token grants.** Any local process that holds the token and can
  reach `127.0.0.1:<port>` can drive every tab in this Chrome as you: read
  pages, click, type, screenshot. Treat it like a password to the browser you
  are signed in to.
- **Nobody trusts the port.** Any local account can bind the port while no
  host is running (after a reboot, a crash, `extension revoke`). So the
  token never crosses the wire on the extension side, and neither end trusts
  a server for answering: the extension sends a fresh nonce with
  `HMAC(token, "ext:" + nonce)`, the host answers `HMAC(token, nonce)`, and
  the extension executes nothing until that answer checks out. A host that
  cannot answer is treated like a bad token: the socket closes and the retry
  alarm stays quiet until setup hands it a token again. The CLI does the same before it ever
  presents the token: `/healthz?nonce=` must return
  `HMAC(token, "healthz:" + nonce)`, and every function that builds a token
  carrying URL takes a proven host, so the compiler refuses a path that
  skips the check.
- **The token stays off the process table and out of transcripts.** The
  engine gets the bridge URL through `AGENT_BROWSER_CDP` in its environment,
  not `--cdp` on its command line; the pairing URL goes to `osascript` on
  stdin; `setup` and `status` print the token only with `--show-token`; and
  the transcript redactor masks the two shapes it could be printed in
  (`token  <hex>` and `/devtools/browser/<hex>`).
- **Who can reach the port.** Only local processes. The host binds loopback
  only. JavaScript on a web page can also open `ws://127.0.0.1`, and three
  checks stop it: a page cannot read the token file
  (`~/.codecast/browser/bridge.json`, mode 0600); the host refuses any
  WebSocket upgrade that carries an `http(s)` Origin header before it looks
  at the token (a page always sends one, the extension sends
  `chrome-extension://`, the CLI sends none); and the HTTP face rejects any
  `Host` other than loopback, which defeats DNS rebinding.
- **Revoke.** `cast browser extension revoke` rotates the token and stops the
  host. The extension is cut off at once, and nothing can drive the browser
  until `setup` hands it the new token. Removing the extension, or toggling
  it off in `chrome://extensions`, is the hard stop.
- **Scope.** The extension holds no remote endpoints, sends nothing off the
  machine, and stores only `{token, port}` in `chrome.storage.local`. A tab
  group is a grouping hint and grants nothing: every tab still needs its own
  attach.
- **Loss of the host.** When the socket to the host drops, the extension
  detaches every tab, so your browser is never left wearing debugger banners
  with nobody on the other end.

## Why a WebSocket instead of Chrome native messaging

Native messaging makes Chrome spawn and own the host process, the reverse of
what cast needs: many short lived CLI processes sharing one long lived
connection, which needs a local socket anyway. It also needs a manifest at
the OS level that names the extension ID, installed per user in a directory
specific to the browser. The loopback WebSocket is one moving part that
serves both sides, and the open socket keeps the MV3 service worker alive
(Chrome 116 and later). The host pings every 20 seconds, and a
`chrome.alarms` tick every 30 seconds reconnects if the worker was ever
torn down. When the socket drops while the worker is awake it retries after
one, two and five seconds first, so a host restart is not a 30 second gap.

## Smoke harness

```bash
bun packages/browser-extension/smoke.mjs                                       # headless scratch Chrome
SMOKE_HEADED=1 bun packages/browser-extension/smoke.mjs                        # watch it happen
SMOKE_ENGINE=/path/to/agent-browser bun packages/browser-extension/smoke.mjs   # pick the engine binary
SMOKE_KEEP=1 bun packages/browser-extension/smoke.mjs                          # leave the scratch dirs in place
```

It launches a **separate** Chrome with a scratch profile (your running
browser is never touched), loads this extension unpacked, checks that Chrome
gave it the ID the CLI expects, pairs it the way `setup` does (opens the
pairing URL over a temporary CDP port and asserts the fragment was read and
cleared), and prints PASS or FAIL per check. First the handshake against the
real extension: a squatter that answers like a host but cannot prove the
token gets no op executed, and the real host turns away an extension paired
with a wrong token. Then four parts:

1. The built in driver: every verb (open, snapshot, find, click, type,
   press, eval, shot, tabs) through `cast browser --real`.
2. The browser engine (agent-browser) pointed at the bridge with `--cdp`:
   open, snapshot, click, screenshot, tab list. Skipped with a note when no
   engine binary is installed.
3. A raw CDP client on the bridge, for what only the bridge adds: a
   background create into a named group, the group title animating while a
   command runs, the border around the driven page, and a screenshot that
   does not show it.
4. The product path: `cast browser target real`, then the plain verbs (open,
   snapshot, click, shot, tabs, stop) on the engine driver, with the CLI's
   state isolated from the machine's. It asserts the tab landed in one group
   named for the session, a second tab from `open --new-tab` joins the same
   group, the overlay is in the DOM but not in the screenshot, the reaper
   closes the tab of a session that ended, and `stop` closes the session's
   own tab.

It needs an unbranded build (Chrome for Testing or Chromium; branded Chrome
137 and later ignores `--load-extension`). It finds one in the puppeteer or
playwright caches, or install one with
`npx @puppeteer/browsers install chrome@stable`.

## Limitations

- `chrome://` pages and the Chrome Web Store cannot be attached (Chrome
  forbids it).
- One extension connection per bridge host: install the extension in one
  Chrome profile. A second connection replaces the first.
- The clone remains the default target. The bridge never activates unless
  you pass `--real` or set `cast browser target real`.
- `setup` opens Chrome by itself on macOS only. Elsewhere, open the printed
  URL by hand.
