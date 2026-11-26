# Installed apps: published pages as desktop apps

Plan: pl-1104. Any published page (`cast publish`) can be installed from its
Share menu as a desktop app on macOS and Windows. It gets its own name and
icon in the Dock or taskbar, Launchpad and Spotlight or the Start menu, and
its own window, and it updates live when the page is republished. With the
person's consent, given per version, it can do more on the computer.

This document is the contract every part of the feature builds to. If a part
needs to differ, change this document first.

## Names

- **Installed app**: an install of one page on one computer. The UI calls it
  an "app" ("Install as app", Settings > Installed apps).
- **App id**: the page slug. A page has at most one install per computer.
- **macOS bundle**: `~/Applications/Codecast Apps/<Name>.app`, with bundle id
  `sh.codecast.app.<slug>`.
- **Windows shortcut**:
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Codecast Apps\<Name>.lnk`,
  or `<Name> (<slug>).lnk` when another installed app already holds that
  name. A device name (`CON`, `NUL`, `COM1` and the like) gets a `_`.
  - AppUserModelID: `Codecast.App.<slug>`.
  - Arguments: `--codecast-app=<slug>`.
  - Target: the stable Codecast executable path that survives updates,
    `%LOCALAPPDATA%\Programs\Codecast\Codecast.exe` for the per-user install
    (`process.execPath` in the running app; an update reinstalls in place).
- **Registry**: Codecast's `settings.json` key `installedApps`, keyed by slug.
  Each record holds:
  - `{slug, name, iconPath, installedAt, grantedVersion, grants: string[], bounds, trayBounds, gate}`.
  - `gate` holds the page's gate keys. Secrets inside it are encrypted with
    Electron `safeStorage`. The stored facts carry no keys: appInfo's icon
    URLs are kept without them and get them back where main hands facts on.

## The manifest

A page declares its app in the same declaration that already carries
`queries` and `state`: `cast-data.json`, or the inline
`<script type="application/cast-data+json">`. Every field is optional. A page
with no `app` block installs with the defaults.

```json
{ "app": {
    "name": "Vitals",
    "icon": "icon.png",
    "window": { "width": 420, "height": 640, "minWidth": 320, "minHeight": 400,
                "resizable": true, "titleBar": "default" },
    "tray": { "icon": "tray.png", "width": 360, "height": 480, "tooltip": "Vitals" },
    "permissions": ["notifications", "menu-bar", "shortcuts"] } }
```

- **`icon`**: a bundle-relative PNG, at least 512 px and square. Without one,
  the server generates a monogram tile: the page title's initial on a color
  derived from the slug. Served at `https://a.codecast.sh/<slug>?icon=<size>`.
- **`tray.icon`**: a monochrome PNG used as a macOS template image. Without
  one, a dot is drawn from the app icon.
- **`titleBar`**: `default` or `hidden`. With `hidden` the page draws its own
  title bar. On Windows it marks drag regions with `-webkit-app-region: drag`.
  On macOS the traffic lights stay, and since `WKWebView` ignores that CSS,
  the top 28 px of the window is a drag strip over the page instead; the page
  keeps that band free of controls.
- **`permissions`**: what the app will ask for. The install sheet shows them
  up front. An app can still ask later through `cast.app.permissions.request`.
- Each published version records the parsed manifest (`artifact_versions.app`)
  so that consent can be compared between versions.
- One parser, `parsePageApp` in `packages/shared/contracts/pageApp.ts`, runs
  in the CLI's publish check and on the server. Unknown fields and unknown
  permissions refuse the publish with the reason; sizes are clamped (window
  200 to 4096 px, tray 120 to 1200 px) and a minimum never exceeds its size.
  `icon` and `tray.icon` must name PNG files the bundle carries.
- A declaration may hold only `app`: such a page has no live data.
- The manifest is part of the page's content hash, so a changed manifest is a
  new version. The current one is `artifacts.app`; a republish without the
  block clears it, a rollback restores the target version's, and an
  in-browser edit carries it over.
- The same file exports `APP_PERMISSIONS`, `APP_PERMISSION_TIER`,
  `APP_PERMISSION_LABEL`, `resolvePageApp` (the manifest with defaults),
  `newPermissions` (what a version adds) and `teamAppsPolicy`, so the engine,
  the install sheet and the server read one table.

## App info

What a host needs to install and run a page, for the person asking.

**HTTP**: `GET https://a.codecast.sh/<slug>?app=1` plus the page's gate keys
(`k`, `e`, `m`), behind the same gates as the page (a locked page answers 403
`{"error":"Locked"}`; the email wall has no exception here). The viewer is
whoever the request proves, in this order:

1. `Authorization: Bearer <Convex auth token>`: the signed-in app.
2. `i=<identity token>`: the page's identity token (`#i=`, minted by
   `artifacts.mintCommentIdentity`).
3. The holder of a team-gated page's `m` token.

With none of them the relation is `anonymous`. Never cached.

**Convex query** for the signed-in app (install sheet, Settings > Installed
apps): `api.artifacts.appInfo({slug, k?, e?, m?})`. It applies the page's gates
as every page read does and returns `{error}` when they refuse. It also returns
`gate`: the keys a host stores for the install (the presented ones, else those
the app hands this reader).

Response:

```json
{ "slug": "k3j2h4", "title": "Vitals", "version": 7, "updated_at": 1795574255689,
  "app": { "name": "Vitals", "icon": "icon.png",
           "window": { "width": 420, "height": 640, "minWidth": 320, "minHeight": 400,
                       "resizable": true, "titleBar": "default" },
           "tray": { "icon": null, "width": 360, "height": 480, "tooltip": "Vitals" },
           "permissions": ["notifications", "menu-bar"] },
  "owner": { "name": "Ada" },
  "icons": { "512": "https://a.codecast.sh/k3j2h4?icon=512&k=…",
             "1024": "https://a.codecast.sh/k3j2h4?icon=1024&k=…" },
  "relation": "owner",
  "policy": { "install": true, "fullAccess": false },
  "gate": { "k": "…" } }
```

`gate` is on the query's answer only. `app` always has every field (defaults
from `resolvePageApp`; `icon` and `tray.icon` are null when not declared).

- **`relation`**: `owner` (the page's owner), `team` (a teammate who sees the
  page in the gallery: the page is in a team workspace they share with the
  owner), `other`, or `anonymous`.
- **`policy.fullAccess`**: the policy of the team whose workspace the page is
  in; a personal page allows it. The engine offers full access only when the
  relation is `owner` or `team` (`not-your-page` otherwise) and this is true
  (`not-allowed-by-team` otherwise).
- **`policy.install`**: false when the page's team, or any team the viewer
  belongs to, turned installs off.

**Icon**: `GET https://a.codecast.sh/<slug>?icon=<size>`, behind the page's
gates. It serves the declared bundle PNG as uploaded, at whatever size it is;
the host scales it. Without one it renders a PNG monogram, RGBA with
transparent corners on the macOS icon grid, at the smallest of 16, 32, 64,
128, 256, 512 or 1024 at or above the asked size (default 512). The renderer
is `convex/lib/appIcon.ts`.

## Permission tiers

| Tier | Grant | What it allows |
|---|---|---|
| Default | always | Everything a browser tab can do, plus `cast.app.window.*`, `cast.app.badge`, `cast.app.openInCodecast`, `cast.app.info`, `cast.app.permissions.*`, `cast.app.on(...)` |
| App permission | each granted separately | `notifications`: native notifications under the app's name and icon. `menu-bar`: a menu bar (macOS) or tray (Windows) item with a popover. `shortcuts`: global shortcuts, which need at least two modifiers, are never a chord the system keeps (Force Quit, screenshots, lock, log out, Task Manager, Ctrl+Alt+Delete, Snip), and are ignored while the screen is locked. `overlay`: always on top, visible on all workspaces, click-through. `agent`: ask the person's agent a question (runs as them through their `cast exec --agent claude --answer-only`, from their home directory, with a first line naming the app; answer-only is claude with no built-in tools and no MCP servers, in dontAsk, ignoring their configured agent args, default params and claude settings, so it can answer but cannot run commands, read or edit files, whatever their own permission mode is; a cast too old for the flag refuses it; at most 5 minutes; counts toward their usage). `login`: open at login. |
| Full access | `full-access` | `cast.app.fs.*` (read, write, list, stat, remove, watch, anywhere the person can reach), `cast.app.process.run` (run a program with args, cwd, env and a timeout; returns exit code, stdout and stderr), `cast.app.shell.open` (open a path or URL with its default app) |

Rules:

- **Consent belongs to a version.** A grant records `grantedVersion`. When the
  page's current version is newer, every non-default call returns
  `needs-consent` until the person approves again. If the new version asks
  for nothing new, the host re-asks in one tap. Your own edits re-ask too.
- **Full access** is only offered when the page's owner is the person, or a
  member of a team the person belongs to, and that team's policy allows it.
  It is never offered for an anonymous or outside page.
- **Team policy** (team settings, set by an admin through
  `api.teams.setAppsPolicy({team_id, install?, full_access?})`, or the store's
  dispatch `setTeamAppsPolicy(teamId, {install?, full_access?})`):
  - `teams.apps_install`: may members install pages at all. Default on.
  - `teams.apps_full_access`: may installed apps get full access. Default off.
  - A personal workspace allows both.
  - Both fields ride on the team rows of `getUserTeams` and
    `getUserTeamsV2`, unset when an admin never set them (read them through
    `teamAppsPolicy`).
- **Mixed versions.** A window still showing version N while version N+1 is
  current is reloaded before any non-default call runs. The engine refuses
  that call with `mixed-version`. It also refuses a window showing a version
  newer than the facts until the facts confirm it: the frame version comes
  from a response header a page's own service worker can forge, so grants
  are only ever recorded for a version the server published.
- **Remote content.** Anything the page loads from another origin runs inside
  the page's own sandbox. Nothing outside the page's document reaches the
  bridge.

## The bridge protocol

The page calls the bridge from one client script, `cast.app`, which both hosts
inject before the page's own scripts run. The client ships with the desktop
app, beside the engine it talks to, at
`packages/electron/installedApps/client.js`; the server does not serve it.

- Electron passes it to the sandboxed app preload (`appPreload.js`) in the
  renderer's command line (`protocol.appWebPreferences`), and the preload runs
  it in the page's world with `webFrame.executeJavaScript`. That runs ahead of
  the page's first script and outside the page's CSP.
- The macOS host writes it into each bundle's Resources at install and
  re-seal (`protocol.clientSource()`), and the shim adds it as a
  document-start `WKUserScript`.

When it is absent (a browser tab, the phone), `window.cast.app` is undefined,
and pages are expected to check for it. It adds only `window.cast.app` and
leaves the rest of `window.cast` (the live data runtime's `data`, `state` and
so on) alone.

```js
cast.app.info()                       // {slug, name, version, surface: "window"|"tray", platform, grants, requested}
                                      //   + on macOS {notifications, notificationSettingsUrl}
cast.app.permissions.request(["notifications"])  // shows the host's consent sheet; resolves to the new grants
cast.app.notify({title, body, tag, silent})      // click focuses the app; fires cast.app.on("notification-click", {tag})
cast.app.tray.set({title, tooltip, badge})       // shows the item; clicking it opens the popover (the same page at surface "tray")
cast.app.tray.remove()
cast.app.shortcuts.register("CmdOrCtrl+Shift+K") // fires cast.app.on("shortcut", {accelerator})
cast.app.window.setAlwaysOnTop(true)             // overlay; setSize, setTitle, focus, minimize, close need no grant
cast.app.window.setVisibleOnAllWorkspaces(true)  // overlay
cast.app.window.setIgnoreMouseEvents(true)       // overlay: click-through; the host restores it when the window is focused from the Dock/taskbar or the tray
cast.app.badge(3)                                // Dock badge, or taskbar overlay on Windows; 0 clears it
cast.app.openInCodecast("/tasks/ct-12")          // shows a codecast path in Codecast's window and brings it forward
cast.app.agent.ask(prompt)                       // {answer}
cast.app.login.set(true)                         // login: open at login
cast.app.fs.readText(path) / writeText(path, text) / stat(path) / remove(path)
cast.app.fs.list(dir)                            // [{name, type: "file"|"dir"|"link"|"other"}]
cast.app.fs.watch(path, cb)                      // resolves to stop(); cb({watchId, type, path})
cast.app.process.run(cmd, args, {cwd, env, timeoutMs})  // {code, signal, stdout, stderr, timedOut, truncated}
cast.app.shell.open(pathOrUrl)
cast.app.on(event, cb) / off(event, cb)          // on() returns an off function
```

On the wire, every call is a message `{id, module, method, args}`, answered
with `{id, ok: true, value}` or `{id, ok: false, code, message}`. `module` is
the namespace under `cast.app`; the top-level calls (`info`, `notify`,
`badge`, `openInCodecast`) use module `app`. `fs.watch` answers with a watch id, and the
client's `stop()` sends `fs.unwatch(watchId)`. The method table, with each
method's tier, is `packages/electron/installedApps/tiers.json`; each method's
argument schema is `ARGS` in `engine.js`.

Paths are absolute or start with `~/`. `process.run` runs the program
directly, never through a shell, kills it and everything it started at the
timeout (30 s by default, 10 min at most) and resolves at once with the
output so far, and keeps at most 4 MB of each output stream. `fs.readText`
reads only regular files and fails past 16 MB read, whatever the file's stat
size says. An app holds at most 64 watches.

`openInCodecast` takes a path inside codecast's web app (`/conversation/<id>`,
`/decisions/<sd-N>`, `/tasks/<ct-N>`): one leading slash, no host, no
whitespace or backslash, at most 2048 characters. A page holding a full
`https://codecast.sh/...` URL passes its path, query and hash. It needs no
grant, because all it can do is show the person their own Codecast. Like
`agent.ask` and `shell.open` it runs in Codecast's main process on both
platforms (`engine.MAIN_METHODS`, answered by `host.js`); the shim forwards
it and performs nothing itself. An older Codecast answers `unknown-method`,
and the page then opens the URL, which the host hands to the default
browser.

Error codes:

- `not-installed`
- `needs-consent`
- `denied`: the person said no
- `not-allowed-by-team`
- `not-your-page`: full access on a page from outside the person's teams
- `mixed-version`
- `unknown-method`
- `bad-args`
- `failed`: the OS call threw; `message` says why

The client turns a refusal into a rejected Promise with an Error whose
`.code` is the code, so a page can show the reason.

Host events go to the page as `{event, data}`. The events are:
`notification-click`, `shortcut`, `tray-click`, `surface`, `version`
(a new version is live, reload pending), `grants`, and `fs-change` (for a
watch; the client also routes it to that watch's callback).

**One engine.** All policy lives in
`packages/electron/installedApps/engine.js`, a pure module with no Electron
imports. It decides every call: is it installed, which tier, is it granted
for this version, does the team allow it, is it the person's own page, are
the args well formed. It then hands allowed calls to a host adapter. The
Windows host (Electron windows) and the macOS host (the native shim)
implement the same adapter interface, documented at the top of
`engine.js`. Neither host re-decides policy.

- The engine runs files and programs itself (`fullAccess.js`, plain Node), so
  full access always executes in Codecast's main process, on both platforms.
  On macOS the shim asks over the socket and gets the result back.
- `permissions.request` goes to the adapter's consent sheet. The engine
  stores what the person approved as the grants for the current version.
  `engine.grant()` is the same write for the host's own screens (the install
  sheet, Settings, a re-ask).
- The frame version the engine checks for `mixed-version` is the version of
  the document the host loaded in that surface. The page response carries it
  in an `X-Cast-Version` header, and the host reads it there (Electron's
  `webRequest.onHeadersReceived`, the shim's `WKNavigationResponse`), never
  from the page's own word.

## Hosting

**Windows (Electron, one process)**

- A shortcut launch reaches the running Codecast through `second-instance`,
  carrying `--codecast-app=<slug>`, or starts Codecast with that argument.
- The app window:
  - is a `BrowserWindow` in partition `persist:app-<slug>`, with
    `sandbox: true`, `contextIsolation: true` and the small app preload,
    never the shell preload;
  - gets `setAppDetails({appId, appIconPath, relaunchCommand, relaunchDisplayName})`,
    which gives it its own taskbar button and makes it pinnable.
- Navigation is locked to `https://a.codecast.sh/<slug>` and paths under it.
  Everything else opens in the default browser.
- Notifications are toasts shown through the app's AUMID, so they carry the
  app's name and icon. Each app shows one toast at a time (one PowerShell process),
  keeps at most three waiting (the oldest is dropped), and may call
  `notify` at most ten times a minute; past that the call fails with
  "too many notifications". A toast process still alive after 45 seconds
  is killed so the next one can show. The title is cut to 256 characters,
  the body to 1024 and the tag to 64, never inside a character, and
  characters XML cannot hold are dropped, so a toast always fits the
  PowerShell command line and always parses.
- Open at login is a `HKCU\...\Run` value named `CodecastApp-<slug>`:
  the quoted Codecast exe, then (from source only) the quoted app path, then
  `--codecast-app=<slug>`.
- The badge is a taskbar overlay, set again each time the app's window shows.
- The tray item is an Electron `Tray` with the app's icon. Its popover is a
  frameless window anchored to the tray.

**macOS (native shim per app)**

- `~/Applications/Codecast Apps/<Name>.app` holds:
  - a small universal Swift executable, shipped in Codecast.app's Resources,
    signed with Codecast's Developer ID, and copied into each bundle;
  - a generated `Info.plist` with `CodecastAppSlug` and `CodecastHostBundleId`,
    plus optional `CodecastPageUrl` (defaults to `https://a.codecast.sh/<slug>`),
    `CodecastSocketPath` (defaults to `<userData>/apps.sock`),
    `CodecastHostVersion` and `CodecastSealKey` (what re-sealing compares),
    `CodecastTrayWidth`/`Height`, and the manifest's window options:
    `CodecastWindowWidth`/`Height`, `CodecastMinWidth`/`MinHeight`,
    `CodecastResizable` (a boolean) and `CodecastTitleBar` (`default` or
    `hidden`). An option the manifest leaves out has no key, and the shim uses
    its default;
  - a generated `app.icns`;
  - `Resources/client.js`, the page client (`protocol.clientSource()`), which
    the shim injects at document start in the main frame.
- `packages/electron/appshim/`: the shim's Swift sources and `build.sh`
  (universal binary), and `install.js` (`install`, `reseal`, `uninstall`),
  which builds, seals, registers and removes bundles.
- The bundle is sealed ad hoc at install time and registered with Launch
  Services. Files Codecast writes carry no quarantine flag.
- The shim owns its process. That gives it its own Dock tile, Cmd-Tab entry,
  menu bar (About, Settings…, Show in Codecast, Uninstall, Services, Hide,
  Quit; File > Close Window; Edit; View > Reload Page, Actual Size, Zoom In,
  Zoom Out, Enter Full Screen; Window), a Dock menu with Show in Codecast,
  and notifications through `UNUserNotificationCenter` under its own
  bundle id. It also owns its tray item (`NSStatusItem` with a panel under it),
  its global shortcuts and its window level. The Edit menu carries its own
  Start Dictation and Emoji & Symbols, with AppKit's automatic copies turned
  off (`NSDisabledDictationMenuItem`, `NSDisabledCharacterPaletteMenuItem`),
  because AppKit appends those on several passes after launch and repeats them.
- Settings… (Cmd-,) opens Codecast's Settings > Installed apps on this app
  through `codecast://open/settings/installed-apps?app=<slug>`, which also
  starts Codecast when it is not running; the page scrolls to that app's row
  and marks it. About shows the app's name and
  icon, the page version it loaded (else the installed one), the page's address without its query (the
  gate keys) and "Made with Codecast". Page zoom (Cmd-+, Cmd--, Cmd-0) is kept
  per app. Window tabbing is off.
- The first launch centers the window on the screen under the pointer; after
  that it opens where it was left (the frame autosave), unless that place is
  on no screen. The web view stays transparent over the window's
  background, which is the color the page had last time (WebKit's theme
  color, else the page's canvas color read once it loads, kept in the app's
  preferences) and the system window color the first time, so the window
  never flashes white or gray before the page's first frame.
  When that color suits the system's light or dark look, the title bar wears
  it too.
- When the page itself does not load, the window is covered the same way:
  "You're offline" when this Mac has no connection, "The page didn't load"
  otherwise, with Try Again. The shim retries every 4 seconds and when the
  app comes forward, and the cover goes once the page loads. Codecast's own
  state (not installed, not running, signed out) takes the cover first.
- The tray page sits in a borderless panel under the menu bar item (an
  `NSPanel` created with `.nonactivatingPanel`, not an `NSPopover`, whose
  window AppKit owns), at the manifest's tray size. It takes the keyboard
  while another app stays in front, and the app's main window stays where it
  is. It closes on Esc, a click anywhere outside it, or a second click on the
  item.
- The window follows the manifest's window options: its size, minimum size
  and resizability. With `titleBar: "hidden"` the page fills the window under
  a transparent title bar (`fullSizeContentView`, no title), the traffic
  lights stay, and a 28 px strip across the top moves the window and zooms it
  on a double click.
- The shim sets `applicationNameForUserAgent`, so WebKit's own user agent
  ends in ` CodecastApp/<CodecastHostVersion> (<slug>)` on every request,
  the document's included.
- The shim renders the page in a `WKWebView`. It reaches the engine in
  Codecast's main process over a Unix socket at
  `<userData>/apps.sock` (mode 0600, newline-delimited JSON,
  `protocol.serveSocket`). It sends
  `{app, frame: {version, surface}, msg: {id, module, method, args}}` and
  reads the reply envelope; host events arrive as `{event, data}` lines on
  the same connection. The shim's own requests go as
  `{app, host: <action>, data, msg: {id}}`, a shape only the shim builds (the
  page reaches the socket only through calls the shim wraps in the first
  envelope). The actions are `report` (notification authorization, the
  window's frame, which Codecast centers the consent sheet on, and that the
  app came forward), `open-in-codecast`, and `uninstall`. Three host events
  stay with the shim and never reach the page: `host-state` `{signedIn}`
  (sent when it connects and whenever sign-in changes; signed out covers the
  page), `host-reload` (after a new version's `version` event), and
  `host-quit` (Codecast is uninstalling the app and removes its data once the
  process is gone). For what the shim owns (notifications, tray,
  shortcuts, window, badge) it asks the engine, then performs the OS action
  itself when the engine allows it. Files, programs, `agent.ask` and consent
  run in Codecast's main process.
- The bridge answers only the main frame, and only while its URL is under
  the page's path. Pages are served with a CSP `sandbox` and so have an
  opaque origin, which is why the check reads the frame URL. Main-frame
  navigation stays under the page's path. Anything else, and every
  `window.open`, goes to the default browser or mail client only when it is
  `http`, `https` or `mailto`; every other scheme (`file`, `ssh`, `smb`,
  `vnc`, settings panes, other apps' schemes) is dropped.
- If Codecast is not running, the shim launches it in the background
  (`open -g -b sh.codecast.desktop --args --background`) and waits for the
  socket, up to 15 seconds. When Codecast is running but the socket is
  missing, it does not launch it again, because that would bring Codecast's
  window forward. A call that finds no engine is refused with `failed`, and
  the next call reconnects. When an open connection drops, the shim retries
  every second without launching Codecast. Once it is back it calls
  `app.info` at once, because the host learns which app a connection belongs
  to only from its first message, and hands the page a `grants` event with
  the reply's `grants` and `version`. With Codecast signed out, it says so and offers to open Codecast.
  That cover, like "isn't running" and "isn't installed", shows the app's
  own icon in color, one line, and the one button that fixes it.
- `app.info` gains two fields only the shim knows: `notifications`, macOS's
  answer for this bundle (`not-determined`, `denied`, `authorized`,
  `provisional` or `ephemeral`), and `notificationSettingsUrl`, the
  Notifications pane of System Settings opened at this app.
- Uninstall from the app's own menu asks once in a native alert, hides the
  window and asks Codecast, which removes the bundle, data and record and
  replies when that is done. On success the shim exits at once, and Codecast
  removes the data again once the process is gone, in case it wrote any on
  the way out. On a failure the window comes back with the reason in an
  alert.
- When Codecast updates, every installed bundle gets the new shim binary and
  page client and is re-sealed on Codecast's next launch, before any app
  connects. A bundle whose window keys no longer match its app's manifest is
  rewritten and re-sealed at the same point.
- macOS keeps each app's data under its bundle id, outside the bundle:
  `~/Library/WebKit/<id>`, `Caches/<id>`, `HTTPStorages/<id>`, `Saved
  Application State/<id>.savedState` and its preferences, which hold the window
  frame. These are the app's partition, and uninstall removes them.

**Both platforms**

- The app loads
  `https://a.codecast.sh/<slug>?host=app&surface=window|tray` plus its gate
  keys. On a new version it reloads, then re-asks consent if grants are now
  stale (see "Facts" below for how the host learns the version).

## Serving pages to installed hosts

An installed app is the page itself, not the page inside codecast's chrome.

- **Who the server serves as a host.** Both hosts send a user agent that
  ends in ` CodecastApp/<desktop version> (<slug>)`: Electron through the
  partition's `setUserAgent`, the shim through
  `WKWebViewConfiguration.applicationNameForUserAgent`. A
  web page cannot set the user agent of a navigation or a frame, so a
  browser never gets the host response. The edge
  (`infra/artifact-edge/worker.js`) bypasses its cache for that user agent.
- **What changes for a host.** No publish bar (no "Published with codecast",
  session pill, version picker or Discuss). No live-reload banner (the host
  reloads itself). The CSP `sandbox` adds `allow-same-origin`, so the page
  gets working `localStorage`, `IndexedDB` and cookies. This is safe only
  because each install has its own storage (an Electron partition per app,
  a WebKit data store per bundle id) and navigation is locked to the slug,
  so no other page ever shares that origin's storage inside an app.
- **`X-Cast-Version`** is on every page document response, host or not, so
  hosts read the loaded version from the response that delivered it.
- **Icon check.** Publish refuses a declared `app.icon` that is not a square
  PNG of at least 512 px, with the reason.

## Facts: version, relation and policy

The engine needs three facts per app: the page's current version, the
person's relation to it, and the team policy. All three come from
`api.artifacts.appInfo`, which needs the person's sign-in. The desktop's main
process has no sign-in, but the web app it hosts does.

- The shell's web app (a hook mounted once by the sync host window in the
  desktop app) subscribes to `api.artifacts.appInfo` for every installed slug
  and pushes each answer to main with `apps.facts(slug, info)`. Convex pushes
  a republish within a second, so the version is live with no polling.
- Main keeps the last facts per slug in the registry record. With no shell
  window alive, it falls back to `?app=1` with the stored gate keys (relation
  then comes from the stored identity token; with none it is `anonymous` and
  full access is refused) every 60 s while an app is open, and on focus.
  A fallback answer may lower the relation and tighten the policy the
  shell's last answer gave, never raise or loosen them: it proves no one at
  this computer (a forwarded `m` link names the member it was minted for,
  who may be the page's owner).
- A version change sends the `version` event to every open surface of that
  app, then reloads it.

## Desktop bridge for the web app

The shell's web app reaches the installed-app host through
`window.__CODECAST_ELECTRON__.apps` (preload), present only in the desktop
app. `packages/web/lib/desktop.ts` wraps it as `desktopApps()`, which returns
null elsewhere.

```ts
apps.list(): Promise<InstalledApp[]>          // {slug, name, iconUrl, version, grantedVersion, grants, requested, needsReview, platform, gate}
                                              //   + on macOS {running, notifications, notificationSettingsUrl}
apps.install(info: AppInfo): Promise<void>    // opens the install sheet for that page; resolves when the sheet closes
apps.open(slug): Promise<void>
apps.uninstall(slug): Promise<void>
apps.setGrants(slug, grants: string[]): Promise<void>  // for the current version
apps.facts(slug, info: AppInfo): void         // the facts feed above
apps.setSignedIn(signedIn: boolean): void     // Codecast's sign-in, whenever it changes
apps.onChange(cb: (apps: InstalledApp[]) => void): () => void  // also fires when a shim connects, leaves or reports
apps.consent: { get(id): Promise<ConsentRequest>, answer(id, {approve, grants}): Promise<void> }
```

`gate` holds the install's `k`, `e` and `m`, so the facts feed can read a
gated page; the identity token stays in main. Main keeps the last
`setSignedIn` value in `settings.json` (`installedAppsSignedIn`; a computer
that never heard counts as signed in). While it is false every app covers its
page with "Codecast is signed out" and an Open Codecast control: the shim's
own overlay on macOS, a cover page in the app window on the Electron host.

**The consent sheet is one web route** in codecast, `/apps/consent/<id>`,
shown in a small, focused shell window that main opens over the app asking
(centered on the app's window, at the screen-saver window level, above every
level an app can reach with `overlay` or its tray panel, so no app window
can cover it with click-through decoys; no Dock presence of its own on
macOS beyond Codecast's). The same route serves all three moments: install,
`cast.app.permissions.request`, and the re-ask after a new version. A
`ConsentRequest` is
`{id, kind: "install"|"request"|"review", info: AppInfo, asked: string[], current: string[], added: string[]}`.
It renders with the shared consequential flow and answers through
`apps.consent.answer`. Closing the window counts as a refusal: `denied` for
a request, nothing installed for an install.
The window is as tall as the sheet: the route reports its natural height with
`apps.consent.resize(id, height)`, and main sets that content height, clamped
to the display's work area (the footer stays pinned while the rest scrolls),
keeps it centered on the asking app, and shows the window on that first
report (or after 400 ms for a route that never reports).

`codecast://install/<slug>?k=…&m=…` (from a browser or `cast publish install`)
makes main ask the shell web app for `appInfo` (the web app handles the deep
link, fetches the info signed in, and calls `apps.install`).
`codecast://uninstall/<slug>` is answered in main: Codecast asks with a
native dialog ("Uninstall Vitals?", Uninstall or Cancel) and uninstalls on
Uninstall. A link that arrives while Codecast starts waits for the host;
a repeat link for a slug whose dialog is open is ignored, and a link whose
path is not a plain slug is refused.
- An app works only while Codecast is installed and signed in. Uninstalling
  removes the bundle or shortcut, the partition's storage and the registry
  record. It never touches the page's shared state.

## Where people meet it

- Every Share menu for a page shows **Install as app**: the page's own header,
  the gallery card, an embed's actions, and the bar on `a.codecast.sh`.
  - In the desktop app it opens the install sheet.
  - In a browser it hands off to the desktop app through
    `codecast://install/<slug>`. When the desktop app is absent, it offers
    the download instead.
- The install sheet uses the shared consequential flow. It shows:
  - the app's icon and name;
  - who made it;
  - each permission it asks for, as a toggle;
  - for full access, a stated line that it can run programs and change files,
    and only when allowed.
  - The confirm button names what happens: "Install Vitals".
- **Settings > Installed apps** lists every app with its icon, version, grants
  (each a toggle), Open, and Uninstall. A pending re-ask shows as a "Review"
  state on its row.
- A `codecast://uninstall/<slug>` link (from a browser, or
  `cast publish uninstall`) asks on the desktop with a native "Uninstall
  <Name>?" dialog before anything is removed.
- Agents use `cast publish install|uninstall|apps <target>`. Install opens the
  same sheet on the person's desktop, so an agent can never grant a
  permission.

## Proving it end to end

`packages/electron/installedApps/e2e/run.mjs` runs the whole flow on a Mac
against Codecast's real `main.js` from source, once per host (the macOS shim,
then the Electron-window host Windows runs), and exits non-zero on any
failure. `e2e/standin.mjs` plays a.codecast.sh with the examples: the bundle
redirect to `/<slug>/`, the host user agent rule, `X-Cast-Version`, the gate's
answers without a key, `?app=1` (relation and policy settable, so a team that
turned installs off can be shown), icons through the `codecast.sh/a/<slug>`
redirect, the generated monogram, live data and a republish.
`packages/convex/convex/installedAppsStandin.test.ts` sends the same requests
to the stand-in and to the real serve route and requires the same status,
headers and body, so the stand-in cannot drift from the server unnoticed. The
edge worker in front of the real server has its own tests
(`infra/artifact-edge/worker.test.js`: the host user agent forwarded and never
cached, `?app=1` never held, the version header passed through).

A small local page plays the web app and calls `apps.*` the way the install
sheet and the facts hook do; the consent route itself is not served, so the
harness answers each consent window through `apps.consent.get/answer`.
`e2e/probe.js` lets it run code in the page under either host. From source,
main.js takes `CODECAST_APPS_PAGE_ORIGIN`, `CODECAST_APPS_ROOT` (where bundles
go) and `CODECAST_APPS_HOST_BUNDLE_ID` (the host a shim checks for and
launches) from the environment, so a run never touches
`~/Applications/Codecast Apps` or the installed Codecast; a packaged build
takes none of them (`installedApps/sourceOverrides.js`).

A notification asked for is not a notification delivered. The run reports
delivery as a blocked gate, never a pass: macOS delivers a shim's
notifications only for a bundle in an Applications folder that a person
allowed. `--real-root` installs as "E2E <name>" in `~/Applications/Codecast
Apps` and makes delivery a check that fails until it is allowed;
`--await-grant <min>` keeps the app installed and re-asks while the person
allows it in System Settings > Notifications. Everything is removed after.
`--strict` exits non-zero while any gate is blocked. After a deploy,
`run.mjs --prod --slug <slug> [--k <key>]` checks the real server and edge and
installs that page in both hosts; until that has passed, the server half is
proven against the stand-in only.
