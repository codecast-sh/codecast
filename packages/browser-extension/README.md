# Cast Browser Bridge

Drive tabs in your **real** Chrome from `cast browser` — real logins, real
session, no profile clone. The cloned browser stays the default for unattended
work; the bridge is for when the agent needs the browser you actually live in,
with you watching.

```
cast CLI ──ws──▶ bridge host (127.0.0.1, token-gated) ◀──ws── this extension ──chrome.debugger──▶ your tabs
```

The extension uses the `chrome.debugger` API, so the CLI's existing driver
verbs (snapshot refs, trusted clicks, typing, screenshots) work identically —
only the transport differs.

## Install (about 3 minutes)

1. In a terminal: `cast browser extension setup`. It starts the local bridge
   host and prints a **token** and **port**.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode** (top
   right), click **Load unpacked**, and select this directory
   (`packages/browser-extension`).
3. Click the extension's **Details → Extension options**, paste the token and
   port, hit **Save & connect**. The status line should say `connected`.
4. Verify from the terminal: `cast browser extension status` → both lines
   green.

Chrome will warn that the extension can use the debugger API. That is the
point: it is the machinery that lets cast drive tabs.

## Use

```bash
cast browser open --real https://example.com   # opens the agent's own tab in your Chrome
cast browser snapshot --real                   # every verb takes --real
cast browser target real                       # or make it sticky for this session
cast browser tabs --real                       # * = this session's tab, ~ = another agent's
```

Rules the CLI enforces: an agent session only ever acts on a tab **it
opened** (or one you name with `--tab`). It never touches your other tabs.

## How you can tell a tab is being driven

- Chrome's own banner — *"cast-browser-bridge is debugging this browser"* —
  shown for as long as the debugger is attached. Clicking **Cancel** there
  detaches instantly; the extension notices and lets go.
- A red `CAST` badge on the extension icon while that tab is attached.
- A Chrome tab group per session, named after it. Its title gains cycling
  dots while a command runs and a checkmark for three seconds after. Every
  tab a session opens joins its group; the group disappears with its last tab.
- A thin border in the group's colour around the driven page. It never takes
  a click, it is hidden for every screenshot, and it goes away when the
  session detaches. It is injected through the debugger session itself, so
  the extension needs no access to page content beyond the debugger it
  already holds. If you cancel the banner yourself the border stays on that
  page until the next navigation.

## Security posture

- **What the token grants.** Anyone holding the token who can reach
  `127.0.0.1:<port>` can drive every tab in this Chrome as you: read pages,
  click, type, screenshot. Treat it like a password to your logged-in browser.
- **Who can reach the port.** Only local processes. The host binds loopback
  only. The one remote-ish attacker who can reach loopback — JavaScript on a
  web page opening `ws://127.0.0.1` — is stopped twice: pages cannot read the
  token file (`~/.codecast/browser/bridge.json`, mode 0600), and the host
  refuses any WebSocket upgrade carrying an `http(s)` Origin header, which
  pages always send and the extension/CLI never do.
- **Revoke.** `cast browser extension revoke` rotates the token and cuts the
  extension off immediately; nothing can drive the browser until you paste
  the new token. Removing the extension (or toggling it off in
  `chrome://extensions`) is the hard stop.
- **Scope.** The extension holds no remote endpoints, sends nothing off the
  machine, and stores only `{token, port}` in `chrome.storage.local`.

## Why a WebSocket instead of Chrome native messaging

Native messaging would make Chrome spawn and own the host process, inverted
from what cast needs (many short-lived CLI processes sharing one long-lived
connection — a local socket would be required anyway). It also needs an
OS-level manifest naming the extension ID, which for an unpacked extension is
derived from its install path and so differs per machine. The loopback WS is
one moving part that serves both sides, and the open socket keeps the MV3
service worker alive (Chrome 116+).

## Smoke test

```bash
bun packages/browser-extension/smoke.mjs           # headless scratch Chrome
SMOKE_HEADED=1 bun packages/browser-extension/smoke.mjs   # watch it happen
```

Launches a **separate** Chrome with a scratch profile (your running browser is
never touched), loads this extension unpacked, runs the full verb set
(open, snapshot, find, click, type, press, eval, shot, tabs) through the
bridge, then checks the tab group, the working indicator and the border
overlay as a raw CDP client, printing PASS/FAIL per check. Requires an unbranded build (Chrome for
Testing or Chromium — branded Chrome ≥137 ignores `--load-extension`); it
finds one in the puppeteer/playwright caches, or
`npx @puppeteer/browsers install chrome@stable`.

## Limitations

- `chrome://` pages and the Chrome Web Store cannot be attached (Chrome
  forbids it).
- One extension connection per bridge host: install the extension in one
  Chrome profile. A second connection replaces the first.
- The clone remains the default target; the bridge never activates unless you
  pass `--real` or set `cast browser target real`.
