# @platform/cli-kit

The update and distribution toolkit: how a compiled CLI finds, verifies and
installs its next version; a small `doctor` framework; a persistent retry queue;
and the release pipeline, npm shim, Homebrew formula and mobile OTA convention
as templates. It is not the codecast `cast` CLI. That product stays in
codecast and imports this.

```
src/update      self update: version and channel logic, manifest, checksum, Updater
src/doctor      check runner and formatter
src/retryQueue  RetryQueue and atomicWriteFile
release/        build-binaries.sh, upload-binaries.sh, publish-mirrors.sh, make-formula.sh,
                npm/ (shim), workflows/ (two GitHub workflows), release.env.example
ota/            guardedRequire.ts, useOtaOnOpen.ts, eas.json, README.md
```

Exports: `@platform/cli-kit` (everything), `@platform/cli-kit/update`,
`@platform/cli-kit/doctor`, `@platform/cli-kit/retryQueue`.

## One update story, four surfaces

Every surface answers the same question with the same three inputs: the
installed version, the latest published version, and the fleet minimum. The
answer is `decideUpdate()` in `src/update/version.ts`: `none`, `available`
(offer it), or `forced` (install now, the installed build is below the
minimum). The minimum is a kill switch the backend holds per surface in a
`system_config` row (`min_cli_version`, `min_desktop_version`, and
`min_mobile_version` for mobile), admin gated, set deliberately after a release
and never by the release itself. A release does not force the fleet; flipping
the minimum does.

**CLI.** `Updater` polls `<releaseBaseUrl>/latest.json` every 24 hours, retries a
failed install of one version after 6 hours, downloads the binary for its
platform key, verifies the sha256 from the manifest, swaps the executable in
place and relinks the short alias. The daemon calls `decide()` on its heartbeat
and restarts itself after a forced update. The release side is `release/`.

**Desktop.** `@platform/desktop` owns the macOS updater (manual `latest-mac.yml`
parse, resumable download, sha512, codesign check, rename swap). It shares
`compareVersions` and `decideUpdate` from here, and reads `min_desktop_version`
the same way. Codecast's daemon applies a desktop update even while the app is
running when the installed app is below the minimum.

**Mobile.** Expo OTA with `preview` and `production` channels and the
`appVersion` runtime policy. Two rules and one switch: guarded `require` for
anything native, no reload mid session, and a blocking store update screen when
the running app version is below `min_mobile_version`. See `ota/README.md`.

**Web and backend.** No client updater; the guard is on the deploy. Convex
pushes a whole tree snapshot, so a stale tree deletes newer functions from
production. The deploy guard scripts live in `templates/deploy` (refuse unless
`origin/main` is an ancestor of HEAD; deploy Convex before pushing web).

## API

### update

- `compareVersions(a, b)`: numeric, segment by segment; returns -1, 0, 1.
- `isBelowMinimum(version, minimum)`: false when no minimum is set.
- `decideUpdate({ current, latest, minimum })`: `UpdateDecision`.
- `resolveChannel(channels, requested?, persisted?)`, `manifestUrl(base, channel)`,
  `STABLE_CHANNEL`: a channel is `{ name, manifestPath }`; explicit beats
  persisted beats the first channel; unknown names fall back.
- `platformKey(platform, arch)`, `assetName(binaryName, key)`: the five keys
  `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`.
- `sha256Hex(bytes)`, `verifySha256(bytes, expectedHex)`.
- `ReleaseManifest`, `isReleaseManifest(value)`: the `latest.json` shape.
- `Updater` / `createUpdater(config)`: `checkForUpdates(force?)`, `decide()`,
  `performUpdate()`, `fetchManifest(channel?)`, `getChannel()`, `setChannel(name)`,
  `listChannels()`, `isDevMode()`, `updateRecentlyFailed(v)`,
  `recordUpdateFailure(v)`, `ensureAlias()`, `updateNotice(v)`,
  `showUpdateNotice(v)`, `readState()`, `writeState()`, `platformKey`,
  `assetName(key?)`. Config: `productName`, `binaryName`, `aliasName?`,
  `currentVersion`, `releaseBaseUrl`, `channels?`, `stateDir`, `minVersion?`
  (async, returns the fleet minimum or null), `checkIntervalMs?`,
  `retryIntervalMs?`, `updateCommand?`, and injected `fetch`, `fs`
  (`UpdaterFs`, default `nodeUpdaterFs`), `download(url, dest)`, `execPath`,
  `platform`, `arch`, `now`, `log`.

### doctor

- `DoctorCheck = { name, run() -> { ok, detail, fix?, warn?, skip? }, dependsOn?, timeoutMs? }`
- `runDoctor(checks, { product, version, onCheck?, now? })` -> `DoctorReport`
  (`ok` is false only on a `fail`; warnings and skips are healthy; a thrown
  error is a failure; a check whose dependency failed is skipped; a timeout is
  a failure).
- `formatCheckLine(record, opts?)`, `formatDoctorReport(report, opts?)`,
  `formatDoctorJson(report)`. `opts.color` takes the product's color functions.

Codecast's checks stay in codecast and become `DoctorCheck` objects: auth,
device (machine key), daemon (pid, launchd, heartbeat), convex connection,
sync backlog, cursor sync, the runtime identity warning, the per client self
test, and the tmux end to end loop with its evidence printing.

### retryQueue

- `RetryQueue<P>` with config `initialDelayMs`, `maxDelayMs`, `maxAttempts`,
  `concurrency`, `persistPath`, `droppedPath`, `persistDebounceMs`,
  `transientMaxDelayMs`, `overloadMaxAgeMs`, `droppedRetentionMs`,
  `droppedMaxEntries`, `onLog`, `onEnqueue`, `serialKey(op)`,
  `classifyError(error, op) -> "network" | "overload" | "permanent" | "retry"`,
  `onFailure(op, error, queue) -> boolean`, `dropContext(op)`, `onRestore(ops)`, `now`.
- Methods: `add(type, params, error?)`, `setExecutor(fn)`, `start()`, `stop()`,
  `clear()`, `notifyConnectionRestored()`, `persistNow({ sync? })`,
  `drop(op, message?, level?)`, `buildOperation(...)`, `replace(removeIds, ops)`, `remove(id)`,
  `getQueueSize()`, `getPendingOperations()`, `hasPending(pred)`, `isActive(id)`,
  `getHealth()`, `getDroppedOperationCount()`, `getDroppedOperations()`,
  `clearDroppedOperations()`, `waitForCompletion(ms)`.
- Helpers: `parseRateLimitDelay`, `isNetworkError`, `isBackendOverloadError`,
  `defaultClassifyError`, `atomicWriteFile(path, content, { mode? })`.

What stayed in codecast: the conversation shape. Message coalescing against
already queued uuids, chunking by count and bytes, per conversation compaction,
the split on timeout with a per conversation chunk limit, stale conversation
errors, the logical queue size and message counts in health. They map onto the
hooks: `serialKey` returns `conv:<id>`, `onFailure` does the split with
`replace` and sheds a stale conversation with `drop` (its own wording on the
log line), `onRestore` does the dedupe and chunk heal, `dropContext` and
`droppedFields` name the session on the drop line and in the drop file, and the
message counts wrap `getPendingOperations()`. `classifyError` is the other way
to reach the same drop when the product has nothing to add to the wording.

### authRelayClient

Not here. The CLI side of the nonce relay (deposit, claim, sweep) is
`@platform/auth/cli`. This package does not duplicate it.

## Adoption for codecast

`packages/cli/src/update.ts` becomes an `Updater` instance plus the snippet
version constants, which move next to `snippets.ts` where they belong:

```ts
import { createUpdater } from "@platform/cli-kit/update";
export const updater = createUpdater({
  productName: "Codecast", binaryName: "codecast", aliasName: "cast",
  currentVersion: pkg.version, releaseBaseUrl: "https://dl.codecast.sh",
  stateDir: `${process.env.HOME}/.codecast`, updateCommand: "cast update",
  minVersion: () => syncService.getMinCliVersion(),
  download: (url, dest) => { execSync(`curl -fsSL "${url}" -o "${dest}"`, { timeout: 180000, stdio: "ignore" }); },
});
```

Files that become imports: `update.ts` (the update half), `retryQueue.ts` (the
generic machine; the conversation hooks stay as a thin `codecastRetryQueue.ts`),
`atomicWrite.ts`, the runner and formatter inside `doctor.ts`, the private
`compareVersions` copy in `daemon.ts`. Scripts that become copies of the
templates: `packages/cli/scripts/build-binaries.sh`, `deploy.sh` (its upload
and mirror halves), `make-formula.sh`, `npm/`, and the two workflows.

## A new app

1. Copy `release/` into the CLI package, fill `release.env`, rename the
   literals listed in `release/README.md`.
2. In the CLI: `createUpdater({...})`; on startup call `checkForUpdates()` and
   `showUpdateNotice()`; add an `update` command that calls `performUpdate()`;
   if there is a daemon, call `decide()` on its heartbeat and restart on `forced`.
3. Backend: a `system_config` table with `min_cli_version` (codecast's
   `systemConfig.ts` is the shape) and a `force-update <version>` admin command.
4. `doctor`: write the product's `DoctorCheck[]`, print with `formatDoctorReport`.
5. A `dl.` origin in front of the R2 bucket with tiered cache on the zone.
