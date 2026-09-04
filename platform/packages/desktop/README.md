# @platform/desktop

Codecast's Electron shell, lifted out of `packages/electron` and parameterized.
One call in the app's `main.js` builds the whole main process: the window and
tray layer, the preload bridge the web app talks to, multi window notification
routing, deep links, the capability policy, the global shortcuts, and the
self-contained macOS updater. Names, ids, URLs, menus and icons come from
config. The behavior is codecast's, byte for byte where it is generic.

Plain CommonJS. Electron is a peer dependency; nothing here needs an Electron
runtime to test.

## Inventory

| File | What it is | Donor |
| --- | --- | --- |
| `src/main.js` | `createDesktopApp(config)`: the main process composition | `main.js` (1,361 lines), split and parameterized |
| `src/config.js` | `resolveDesktopConfig`: validation and defaults | new; the constants main.js hardcoded |
| `src/preload.js` | the preload every window loads | `preload.js` |
| `src/bridge.js` | `createBridge`: the object the preload exposes, testable without Electron | `preload.js` body |
| `src/notificationRouter.js` | which window a banner lands in, which window may play sound, duplicate collapse | `notificationRouter.js`, logic unchanged, route table now a parameter |
| `src/updaterNet.js` | redirect following GET, feed fetch, resumable download with inactivity timeouts and abort | `updaterNet.js`, byte identical |
| `src/updaterLogic.js` | version compare, feed file per channel, feed parse, download decision, the kill switch, the swap script | pure parts of main.js |
| `src/notarize.js` | `createNotarizeHook`: electron-builder afterSign hook taking identities from env | `notarize.js` |
| `src/webCache.js` | the offline copy of the site: manifest check, verified download, atomic swap, request planning, the protocol handler | new |
| `templates/vite-release-manifest.js` | Vite plugin that publishes `release.json`, the manifest the copy reads (`@platform/desktop/vite`) | new |
| `templates/electron-builder.js` | electron-builder config as a function of the product values | `package.json` "build" |
| `templates/entitlements.mac.plist` | hardened runtime entitlements (JIT, mic, camera) | same file |
| `templates/NOTARIZATION.md` | the env var list and the one time setup | new |
| `templates/codecast.config.js` | codecast's full config, the adoption example | new |
| `templates/release.sh` | bump, build, asar check, R2 upload, feed check, CDN warm | `scripts/release.sh`, parameterized by env |
| `index.d.ts` | types for the config, the API, the bridge | new |

Tests (`bun test`, 36 bun tests plus 6 Node tests): `notificationRouter.test.js`
(ported from the donor, only the runner import changed), `updaterLogic.test.js`,
`bridge.test.js` (the buffering rules), `notarize.test.js`, `config.test.js`,
`main.test.js` (`createDesktopApp` against a fake Electron object), and
`updaterNet.test.js`, which runs `updaterNetSuite.node.js` under `node --test`
(local http server: redirect, resume with Range, hash across attempts,
truncation, abort, inactivity). That suite is Node only because the updater runs
in Electron's Node and bun's http and fs streams differ in the corners it
exercises.

## Using it

```js
// main.js of the app
const { createDesktopApp } = require("@platform/desktop");
createDesktopApp(require("./desktop.config"));
```

`createDesktopApp` returns a small API (`navigateMain`, `checkForUpdate`,
`installUpdateAndRestart`, `showNotification`, `togglePalette`, `showCompose`,
`openFullSessionInMain`, `toggleEnvironment`, `getMainWindow`, `config`). Call
it once, before Electron's `ready`: it takes the single instance lock and claims
the protocol synchronously, like the donor did at module top.

The preload is the package's own file. `createDesktopApp` points every window
at it and passes `--bridge-global=<name>` through `additionalArguments`, so the
renderer finds the bridge on `window[<name>]`.

## Config surface

Required: `productName`, `appId` (reverse DNS), `protocol` (deep link scheme),
`urls.prod` (https). `update.baseUrl` and `update.teamId` are required unless
`update.enabled` is false. Everything else has a default.

| Key | Meaning | Default |
| --- | --- | --- |
| `slug` | token that derives names below | `protocol` |
| `envPrefix` | `<P>_URL` overrides the start URL, `<P>_USER_DATA` isolates a dev profile, `<P>_CLAIM_PROTOCOL=1` lets a dev run claim the scheme | slug upper cased |
| `urls.local` | the mkcert dev origin; enables Switch Environment and trusts that one host's cert | none |
| `trustedHosts` | extra first party hostnames for permission grants | prod and local hosts, loopback |
| `bridgeGlobal` | `window[...]` in the renderer | `__<SLUG>_ELECTRON__` |
| `events.navigate` | CustomEvent the shell dispatches to move the web app | `<slug>-navigate` |
| `events.newSession` | window global the shell calls for New Session | `__<SLUG>_NEW_SESSION` |
| `events.htmlClass` | class added to `<html>` in every window | `electron-desktop` |
| `assets.icon`, `assets.tray` | window icon, tray template image (no tray when absent) | none |
| `window.*` | size, minimum size, background color, traffic light position | 1200x800, 800x600, `#002b36`, 16,12 |
| `menu.navItems` | `{label, path}` entries for Go, tray and dock | `[]` |
| `menu.helpLinks` | `{label, url}` entries for Help | `[]` |
| `menu.settingsPath` | enables Settings… (Cmd+,) and Keyboard Shortcuts | none |
| `menu.newSessionLabel` | label for the New Session entries; `null` removes them | `New Session` |
| `menu.dockItems` | dock menu entries | first two navItems |
| `palette` | `{path, width, height}` floating palette window; absent = none | none |
| `shortcuts.defaults` | key to accelerator map for the built in actions `toggleWindow`, `togglePalette`, `newSession`, `toggleEnv` | `{}` |
| `shortcuts.settings` | `{DEFAULT_SHORTCUTS, mergeShortcuts, diffOverrides}`; see "left for @platform/keys" | a plain merge and diff |
| `shortcuts.actions` | extra named actions, each called with the API | `{}` |
| `notificationRouter` | `{areas, entityQueryParams}` route table for banner routing, plus `windowBonus` and `preferredLeader` for a window that owns the ringer | codecast's table, no hooks |
| `update.baseUrl` | where `<channel>-mac.yml` and the zips live | required |
| `update.channel` | feed file name prefix | `latest` |
| `update.teamId` | Apple Team ID the downloaded bundle must carry | required |
| `update.minVersion` | async function returning the fleet floor, the kill switch | none |
| `update.initialDelayMs`, `update.intervalMs` | first check after launch, then every | 8 s, 1 h |
| `extraPermissions` | added to the baseline grant table | `[]` |
| `web.cache` | keep a full local copy of the site and serve the app host from it (below) | `false` |
| `web.manifestPath`, `web.seedDir`, `web.passthrough` | where the site publishes its manifest; a packaged copy for the first launch; path prefixes the server owns | `/release.json`, none, `[]` |
| `web.startupTimeoutMs`, `web.checkIntervalMs` | how long a launch waits for the manifest check; how often to re-check | 6 s, 15 min |
| `web.verify` | `all` verifies every downloaded file's hash; `assets` exempts HTML documents, for a CDN that rewrites them | `all` |
| `extraProtocols` | `{scheme, name, claimOnFirstRun, menuLabel}` schemes beyond the app's own (a mail app: `mailto`) | `[]` |
| `hooks.onReady` | called with the API once the shell is up | none |
| `downloadUrls` | `(url) => boolean`: pages the app opens that are downloads, saved in-app | none |
| `window.rememberBounds` | size and position persist in settings.json | `true` |
| `about.copyright`, `about.website` | About panel and Help website entry | product name, prod URL |

Validation errors throw `DesktopConfigError` at `createDesktopApp` time, before
any window exists.

## The auto update flow, end to end

This path does not use electron-updater or Squirrel. Squirrel.Mac's install
step does not run on macOS 26 (launchd accepts the ShipIt job and never runs
it), so `quitAndInstall()` quits the app and nothing swaps the bundle. The shell
does the whole job itself.

**Publishing a release.** `templates/release.sh` bumps `package.json` with jq,
runs electron-builder (signing, then the afterSign hook notarizes), checks that
the asar contains every local require and this package, uploads the zip, the
dmg, both blockmaps and the feed file to R2 (immutable cache headers on the
artifacts, `no-cache` on the feed), re-reads the published feed to confirm the
version changed, and fetches each artifact once through the public domain so
the CDN is warm before the fleet asks. electron-builder writes the feed as
`latest-mac.yml` (or `<channel>-mac.yml`) with the version, the zip name and its
sha512.

**Checking.** Only a packaged macOS app checks; a manual check elsewhere says
so in a notification. Eight seconds after launch, then hourly, and on any
"Check for Updates…" or the web's "Try again", the shell fetches
`${baseUrl}/${channel}-mac.yml`, parses version, zip name and sha512 by hand,
and compares the version to `app.getVersion()` numerically segment by segment.
Not newer means done (a manual check says "up to date").

**Downloading.** The zip streams to `userData/update-stage` with
`downloadResumable`: four attempts, a 30 second bound on both connect and read
inactivity, `Range` resume from whatever the last attempt left on disk, the
running hash carried across attempts so a resumed file still yields the digest
of the whole file. Progress is whole file percent and never moves backwards;
the renderer sees it as `update-status` `{status: "downloading", percent}`. A
byte count short of `content-length` is a failure even when the stream ends
cleanly. A sha512 mismatch rejects the file.

The run in flight is a promise, not a boolean. A user retry aborts a wedged
download, waits for it to settle, and starts fresh; an aborted run emits no
error status, so a superseded attempt cannot flash an error over the fresh
one's progress.

**Verifying.** `ditto` extracts the zip; `codesign --verify --strict --deep`
must pass and `codesign -dvv` must print `TeamIdentifier=<update.teamId>`. A
bundle signed by anyone else is never staged.

**Staging.** The verified bundle is copied to `.<Product>.app.incoming` next
to the running bundle, on the same volume, so the swap is two renames. The
bundle path comes from `app.getPath("exe")`, not `/Applications`, so a user who
installed elsewhere still updates. The shell emits `{status: "ready"}` and
shows a native "ready, click to restart" notification.

**Applying.** "Restart now" (the bridge's `restartForUpdate`, the notification
click, or the kill switch) spawns a detached `/bin/sh` that waits for this pid
to exit, renames the old bundle aside, renames the incoming one in, rolls back
if either rename fails, clears the quarantine attribute, deletes the old bundle
and reopens the app in the foreground. The app then quits itself, which is what
lets the rename succeed.

**Channels.** `update.channel` selects the feed file. Publish a beta build with
electron-builder's `--config.publish.channel=beta` (it writes `beta-mac.yml`)
and ship a build configured with `channel: "beta"` to the testers; the stable
fleet keeps reading `latest-mac.yml`. Channel is a build time value, not a
user setting.

**The kill switch.** A release never forces the fleet: users are prompted and
otherwise update on the next quit. To force, raise the minimum version that
`update.minVersion` resolves. On every check the shell reads it; when the
installed version is below the floor, a staged bundle is installed at once
instead of waiting for "Restart now". Codecast keeps the floor in Convex
`systemConfig` (`min_desktop_version`, written by
`cast desktop-force-update <version>`); its daemon reads the same value and
applies the update from outside the app (quit, swap, relaunch) for clients too
old to carry this updater. The shell cannot query Convex anonymously, so
codecast's config reads the floor through a small same-origin web route; any
https JSON endpoint works.

**Compatibility story.** Every status the shell emits replays to a renderer
that loads later (`update-status` keeps only the latest), and the web gates on
each bridge method being present. `BRIDGE_METHODS` lists the full surface so a
consumer can diff an older shell against it.

## The offline copy of the site

With `web.cache: true` the shell loads the site over https as before, but
never straight from the network: it keeps one complete copy of the site under
`userData/web-cache/<release>/` and answers every request for the app host
from it. The origin is unchanged, so storage, cookies, sign-in, and the
backend's origin allowlist see the same `https://` identity as the browser.

**The manifest.** The site publishes `release.json`: a release id that is a
hash over every file's path and content, and each file with its sha256. The
Vite plugin writes it after the build:

```js
import { releaseManifest } from "@platform/desktop/vite";
export default defineConfig({ plugins: [react(), releaseManifest()] });
```

**Refresh.** At launch, the shell fetches the manifest (no-store) and compares
its id with the copy's. A different id downloads every file into a staging
directory, verifies each hash, and swaps the pointer in one rename; a bad
hash or a failed file discards the stage and keeps the current copy. The
launch waits at most `web.startupTimeoutMs` for that first check, so an
online start paints the current release and an offline one paints the copy
at once. It re-checks every `web.checkIntervalMs` and on wake from sleep;
when a newer release lands while a page is up, the page hears
`onWebUpdate({ release, from })` on the bridge and reloads when it wants to.

**When the CDN rewrites the HTML.** A hash is computed over what was built,
and some CDNs do not serve what was built: Cloudflare's email address
obfuscation rewrites `mailto:` links and injects a decoder script, so
`index.html` on the wire never matches the manifest and every download is
rejected — the app keeps working from its copy and silently stops updating.
Either turn the transform off, or set `web.verify: "assets"`, which keeps the
hash check on every script, stylesheet and font and trusts the document to the
same degree as the TLS connection that delivered it.

**Serving.** GET and HEAD for the app host: a file in the copy is served with
its mime type; a navigation that misses gets `index.html` (the same SPA
fallback the site's server does); anything under `web.passthrough` and every
other request goes to the network untouched (`net.fetch` with
`bypassCustomProtocolHandlers`). The copy's own downloads bypass the
interceptor the same way. With no copy at all and no network, a navigation
gets a small "needs a connection" page instead of a blank window.

**The seed.** `web.seedDir` names a copy of the site packaged with the app
(electron-builder `extraResources`, its `release.json` written by
`writeManifest` or the plugin), used when nothing has been downloaded yet,
so even the first launch works offline. The seed's id is computed the same
way as the site's, so a seed of the deployed build is "fresh" on the first
check.

The local dev URL is never cached: its files change under the app and Vite
serves them.

## Notarization

Signing is electron-builder's (`mac.identity`, hardened runtime, the
entitlements template). The afterSign hook from `createNotarizeHook()` reads
`NOTARIZE_KEYCHAIN_PROFILE`, or `APPLE_ID` + `APPLE_PASSWORD` (+
`APPLE_TEAM_ID`), notarizes the built `.app`, and skips with a printed line
when neither is set. `templates/NOTARIZATION.md` has the one time
`notarytool store-credentials` setup and the post build checks. The identity's
Team ID must equal `update.teamId`, or the updater will refuse the app's own
releases.

## Adopting in codecast

`packages/electron` becomes a dependency on this package, a config file, the
assets, and the release script. File by file:

| Today | After |
| --- | --- |
| `main.js` | `createDesktopApp(require("./desktop.config"))` (three lines) |
| `preload.js` | deleted; the package's preload is used |
| `notificationRouter.js` + test | deleted; `@platform/desktop` exports them |
| `updaterNet.js` | deleted; `@platform/desktop` exports it |
| `notarize.js` | deleted; the builder template wires `createNotarizeHook()` |
| `shortcutSettings.js` + test | moves to `@platform/keys` (see below), passed in as `shortcuts.settings` |
| `package.json` "build" | `electron-builder.config.js` calling `templates/electron-builder` with appId `sh.codecast.desktop`, product `Codecast`, protocol `codecast`, publish URL `https://dl.codecast.sh/desktop`, identity `Ashot Petrosian (WRG9THCK9Q)`, the mic and camera strings, and `files` for the icons; drop the `electron-updater` dependency nothing imports |
| `entitlements.mac.plist` | deleted; the template is the default |
| `scripts/release.sh` | `templates/release.sh` with `PRODUCT_NAME=Codecast R2_BUCKET=codecast R2_PREFIX=desktop PUBLIC_BASE_URL=https://dl.codecast.sh/desktop` and `AFTER_RELEASE` doing the web download URL rewrite and commit |
| `assets/` | stays |

`templates/codecast.config.js` is the complete config. The web app keeps
working unchanged: the bridge global is still `__CODECAST_ELECTRON__`, the
navigate event `codecast-navigate`, the New Session global
`__CODECAST_NEW_SESSION`, the html class `electron-desktop`, the env vars
`CODECAST_URL`, `CODECAST_USER_DATA`, `CODECAST_CLAIM_PROTOCOL`, and every IPC
channel name. The desktop-relay sign in (`AuthProviderButtons.tsx` opening
`/auth/cli?mode=desktop&nonce=…` through `openExternal`, then redeeming with
the `desktop-relay` provider) needs only `openExternal`, which is unchanged and
https-only.

The electron-builder `files` list must keep `node_modules/@platform/desktop/src/**`
(the template adds it). The release script checks the asar for it; v1.1.85
shipped an app that died at boot over a missing local module.

## Giving whisk or aurora a desktop app

Neither has one today. The steps:

1. Add `@platform/desktop`, `electron`, `electron-builder`, `@electron/notarize`
   to a new `packages/desktop` in the app repo with `"main": "main.js"`.
2. Write `desktop.config.js`: product name, appId, protocol, `urls.prod`, icons,
   the nav items the app has, `update.baseUrl` on a `dl.` origin with tiered
   cache, the Team ID, and a `minVersion` source if the app wants a kill switch.
   Leave out `palette` and set `menu.newSessionLabel: null` unless the web app
   implements those globals.
3. `main.js`: `createDesktopApp(require("./desktop.config"))`.
4. In the web app, read `window.__<SLUG>_ELECTRON__` (type it with
   `DesktopBridge` from `index.d.ts`), gate on method presence, handle the
   `<slug>-navigate` CustomEvent, and call `showNotification`,
   `reportWindowState`, `onUpdateStatus` where it fits. Expose
   `window.__<SLUG>_NEW_SESSION` only if the app has a New Session idea.
5. `electron-builder.config.js` from the template; an Apple Developer identity,
   a notarization keychain profile, and `templates/release.sh` with the env
   set for the app's bucket and prefix.
6. Sign in: the embedded window has no provider sessions, so the login page
   should open its OAuth flow in the system browser through `openExternal`
   and redeem a nonce the way codecast's `desktop-relay` provider does.

## Left for @platform/keys, on purpose

`shortcutSettings.js` (46 lines, with its 58 line test) is the default
accelerator map plus the legacy `toggleCompose` → `newSession` migration and
the overrides-only persistence. The design files it under `@platform/keys`, so
it is not here. This package takes it by injection: `shortcuts.settings =
{DEFAULT_SHORTCUTS, mergeShortcuts, diffOverrides}`. Until keys ships it, a
plain merge and diff against `shortcuts.defaults` is used, which is correct for
every app except one that carries codecast's pre-April settings.json; codecast
should pass the keys module when it adopts.
