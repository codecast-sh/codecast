# Mobile App Release Guide

## Prerequisites

1. **Expo Account**: Login to EAS
   ```bash
   npx eas login
   ```

2. **Apple Developer Account**: Ensure you're enrolled in Apple Developer Program

3. **App Store Connect**: Create app listing (one-time setup)

## One-Time Setup

### 1. Initialize EAS

```bash
cd packages/mobile
npx eas init
```

This creates a project in your Expo account and updates `app.json` with your `projectId`.

### 2. Update app.json

The checked-in values are Codecast's own (`owner: "ashotp"`, `com.ashotp.codecast`). A fork sets its own:
```json
{
  "expo": {
    "owner": "your-expo-username",
    "ios": {
      "bundleIdentifier": "com.yourdomain.codecast"
    },
    "extra": {
      "eas": {
        "projectId": "your-project-id-from-eas-init"
      }
    }
  }
}
```

### 3. Create App Store Connect Listing

1. Go to [App Store Connect](https://appstoreconnect.apple.com)
2. Click "Apps" > "+" > "New App"
3. Fill in:
   - Platform: iOS
   - Name: Codecast (or your chosen name)
   - Primary Language: English (U.S.)
   - Bundle ID: `com.yourdomain.codecast`
   - SKU: `codecast-ios-001`
   - User Access: Full Access
4. Copy the **Apple ID** (10-digit number from app page URL)
5. Put it in `eas.json` under `submit.production.ios.ascAppId`

### 4. Configure EAS Credentials

```bash
cd packages/mobile
npx eas credentials
```

Choose "iOS" > "production" and follow prompts to generate:
- Distribution Certificate
- Provisioning Profiles, one for the app and one for the `CodecastWidget` target (`packages/mobile/targets/widget`, bundle id `<app bundle id>.widget`)

EAS manages these automatically with your Apple Team ID (`ios.appleTeamId` in `app.json`).

Submission authenticates with an App Store Connect API key rather than an Apple ID. Create one in App Store Connect (Users and Access > Integrations, role App Manager), keep the `.p8` outside the repo, and point `submit.production.ios` in `eas.json` at it (`ascApiKeyPath`, `ascApiKeyId`, `ascApiKeyIssuerId`).

### 5. Set Environment Variables

The app reads `EXPO_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_KEY` and `EXPO_PUBLIC_POSTHOG_HOST`. `packages/mobile/.env` is gitignored, so cloud builds need them as EAS environment variables:
```bash
npx eas env:create production --name EXPO_PUBLIC_CONVEX_URL --value "https://convex.yourdomain.com" --visibility plaintext
npx eas env:create preview --name EXPO_PUBLIC_CONVEX_URL --value "https://convex.yourdomain.com" --visibility plaintext
```

`eas update` bundles on your machine, so OTA updates read the local `packages/mobile/.env` instead. Keep it set to production values.

## Build Commands

```bash
cd packages/mobile

# Development build (simulator)
bun run build:dev

# Preview build (internal ad hoc distribution, installed from an EAS link; not TestFlight)
bun run build:preview

# Production build (the one TestFlight and the App Store take)
bun run build:prod

# Upload the latest build to App Store Connect (lands in TestFlight)
bun run submit:ios

# Build + auto-submit in one command
bun run release:ios
```

## Release Process

Build from a clean checkout of `origin/main` (`git worktree add --detach <dir> origin/main`, then `bun install --frozen-lockfile` and copy `packages/mobile/.env`). EAS uploads uncommitted changes, so building from a shared tree can ship another session's half-finished edit.

### TestFlight (Internal Testing)

1. Build production:
   ```bash
   bun run build:prod
   ```

2. Upload it:
   ```bash
   bun run submit:ios
   ```

3. In App Store Connect:
   - Go to TestFlight tab
   - Add internal testers
   - Build will be available after processing (~10-30 min)

### App Store Release

1. Complete App Store listing in App Store Connect:
   - Screenshots (6.9" iPhone, plus 13" iPad because `supportsTablet` is on)
   - App description, keywords, support URL
   - Privacy policy URL
   - Age rating questionnaire
   - App category

2. Build and submit:
   ```bash
   bun run release:ios
   ```

3. In App Store Connect (`eas submit` only uploads; the release is manual):
   - Create the new version and add "What's New"
   - Select the build for release
   - Submit for review

4. Wait for Apple review (1-3 days typically)

## OTA Updates

Push JavaScript updates without a new App Store binary:

```bash
bun run update:preview       # preview channel (internal ad hoc builds)
bun run update:production    # production channel (TestFlight and App Store builds)
```

`scripts/deploy-all.sh` pushes the production OTA as part of a full deploy (`--preview` sends it to preview instead) and skips it when nothing under `packages/mobile` changed.

`runtimeVersion` uses the `appVersion` policy, so an update reaches only binaries with the same `version` as the tree that published it. After a version bump, OTA updates stop reaching the older binaries.

An update also runs on binaries built before any native library it uses. A native package outside the frozen baseline in `packages/mobile/lib/nativeDeps.guard.test.ts` must never be imported statically: load it through `optionalNative` (`packages/mobile/lib/optionalNative.ts`) and handle `null`. A new native package needs a new binary build (see the repo-root `CLAUDE.md`).

## Version Management

EAS keeps the build number remotely (`appVersionSource: "remote"` in eas.json), and the production profile's `autoIncrement` bumps it on every build. Check it with `npx eas build:version:get`.

The user-facing version is manual. Bump it in `app.json` for each App Store release (this also moves the OTA runtime, see above):
```json
{
  "expo": {
    "version": "1.1.0"
  }
}
```

## Troubleshooting

### Credentials Issues
```bash
npx eas credentials --platform ios
```

A `--non-interactive` build never creates or changes credentials. A new native target or a new entitlement fails it with "Credentials are not set up" or a profile mismatch; run one `eas build` attached to a terminal so EAS can generate the profile, and later non-interactive builds reuse it.

### Build Failures
Check build logs at your Expo dashboard: `https://expo.dev/accounts/<your-username>/projects/codecast/builds`

Every build profile in `eas.json` pins `"bun"`. Keep it equal to the local bun version: EAS otherwise installs with its own older bun, whose hoisted layout breaks `metro.config.js`.

### Stuck Submission
```bash
npx eas submit --platform ios --id <build-id>
```
