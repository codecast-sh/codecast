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

Set your own values:
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
5. Set as `ASC_APP_ID` env var for EAS submit

### 4. Configure EAS Credentials

```bash
cd packages/mobile
npx eas credentials
```

Choose "iOS" > "production" and follow prompts to generate:
- Distribution Certificate
- Provisioning Profile

EAS manages these automatically with your Apple Team ID.

### 5. Set Environment Variables

For cloud builds, set secrets via EAS:
```bash
npx eas secret:create --name EXPO_PUBLIC_CONVEX_URL --value "https://convex.yourdomain.com" --scope project
npx eas secret:create --name APPLE_ID --value "you@example.com" --scope project
npx eas secret:create --name ASC_APP_ID --value "1234567890" --scope project
npx eas secret:create --name APPLE_TEAM_ID --value "XXXXXXXXXX" --scope project
```

## Build Commands

```bash
cd packages/mobile

# Development build (simulator)
bun run build:dev

# Preview build (internal testing via TestFlight)
bun run build:preview

# Production build
bun run build:prod

# Submit latest build to App Store
bun run submit:ios

# Build + auto-submit in one command
bun run release:ios
```

## Release Process

### TestFlight (Internal Testing)

1. Build preview:
   ```bash
   bun run build:preview
   ```

2. Submit to TestFlight:
   ```bash
   bun run submit:ios
   ```

3. In App Store Connect:
   - Go to TestFlight tab
   - Add internal testers
   - Build will be available after processing (~10-30 min)

### App Store Release

1. Complete App Store listing in App Store Connect:
   - Screenshots (6.7" and 5.5" required)
   - App description, keywords, support URL
   - Privacy policy URL
   - Age rating questionnaire
   - App category

2. Build and submit:
   ```bash
   bun run release:ios
   ```

3. In App Store Connect:
   - Select the build for release
   - Submit for review

4. Wait for Apple review (1-3 days typically)

## OTA Updates

Push JavaScript updates without a new App Store binary:

```bash
bun run update:preview       # TestFlight channel
bun run update:production    # Production channel
```

## Version Management

EAS manages version incrementing automatically via `appVersionSource: "remote"` in eas.json.

To manually set version, update `app.json`:
```json
{
  "expo": {
    "version": "1.1.0"
  }
}
```

Build numbers auto-increment per build.

## Troubleshooting

### Credentials Issues
```bash
npx eas credentials --platform ios
```

### Build Failures
Check build logs at your Expo dashboard: `https://expo.dev/accounts/<your-username>/projects/codecast/builds`

### Stuck Submission
```bash
npx eas submit --platform ios --id <build-id>
```
