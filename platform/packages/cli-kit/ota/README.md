# Mobile OTA convention

Expo Updates ship JavaScript to an installed binary. The convention below is
what codecast and aurora (Sapling) converged on. Copy the files in this
directory into the app and follow the three rules.

## Channel layout

`eas.json` (template here) defines two channels that ship updates: `preview`
(internal distribution, testers) and `production` (store builds). The
`development` profile is the dev client and takes no OTA. `app.json` sets
`runtimeVersion: { policy: "appVersion" }` and `updates.url` to the EAS project
URL. With the `appVersion` policy an OTA can only land on a binary with the same
`version`, so a native change means a version bump and a store build, and an
OTA can never target a binary that predates its native modules on purpose. It
can still target one by accident, which is rule 1.

Publish: `eas update --channel preview --message "..."`, then the same for
`production` once verified. Store builds: `eas build --profile production`.

## Rule 1: guarded require for every native module touched by an OTA

An OTA can land on an older binary with the same version string if the binary
was built before the module was added. A top level import then throws during
module evaluation, expo-updates marks the update failed, and the app silently
rolls back to the previous bundle. Everything native must load through a
synchronous `require` inside try/catch that falls back to a no-op, called at
first use. Never a top level import, never a dynamic `import()` (a production
bundle resolves it differently). `guardedRequire.ts` is the helper. Codecast
uses this shape in `packages/mobile/lib/analytics.ts` for Sentry and PostHog
and in `lib/dispatchOutbox.ts`.

## Rule 2: never reload mid session

`useOtaOnOpen.ts` checks, fetches and reloads when the app comes to the
foreground, before the user is doing anything. Codecast's variant applies when
the app goes to the background. Both avoid `reloadAsync()` during use:
expo-updates can mark the update launched and then silently roll it back, and
a reload yanks state out from under the user.

## Rule 3: the minimum version kill switch applies to mobile too

The backend holds a `system_config` row per surface (`min_cli_version`,
`min_desktop_version`; add `min_mobile_version`). The pattern is codecast's
`packages/convex/convex/systemConfig.ts`: one admin gated upsert, one query per
key. For mobile the client reads the key on open, compares its
`Updates.runtimeVersion` (the app version) with `compareVersions` from
`@platform/cli-kit`, and when below the minimum shows a blocking "update from
the store" screen. An OTA cannot raise a binary version, so the mobile switch
blocks rather than installs; it exists so a build with a broken native layer
or a security hole can be taken out of service without waiting on App Review.
Set it only after the store build that satisfies it is live.
