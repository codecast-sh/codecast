# Notarization

The afterSign hook (`createNotarizeHook`) reads its credentials from the
environment. It notarizes only macOS builds, and it skips with a printed line
when it finds no credentials. A release build must show "Notarization complete"
in its log.

## Environment variables

One of the three sources is required. The first one present wins, in this order.

| Variable | Use |
| --- | --- |
| `APPLE_API_KEY` | Path to an App Store Connect API key (`AuthKey_<id>.p8`). Preferred: read from a file, it needs no keychain, works from non-interactive shells, and survives Apple ID password changes. |
| `APPLE_API_KEY_ID` | That key's ID. |
| `APPLE_API_ISSUER` | The issuer ID shown above the key list in App Store Connect. |
| `NOTARIZE_KEYCHAIN_PROFILE` | Name of a notarytool keychain profile. |
| `APPLE_ID` | Apple ID email. Used with `APPLE_PASSWORD`. |
| `APPLE_PASSWORD` | An app specific password for that Apple ID, not the account password. Apple revokes every app specific password when the account password changes. |
| `APPLE_TEAM_ID` | The 10 character Team ID. Pass it with the Apple ID pair. |

electron-builder notarizes on its own when `APPLE_API_KEY*` are in its process
environment, so hand the key to the hook instead (`createNotarizeHook({ env })`)
to notarize once.

## API key setup

App Store Connect, Users and Access, Integrations, App Store Connect API: make a
team key (Developer access is enough), download the `.p8` once, and keep it
outside any repo (for example `~/.app-store-connect/`, mode 600).

## Keychain profile setup

Run from an interactive Terminal: from an agent or launchd shell the keychain
write fails with "User interaction is not allowed".

```sh
xcrun notarytool store-credentials codecast \
  --apple-id you@example.com \
  --team-id WRG9THCK9Q \
  --password <app specific password>
```

Then build with `NOTARIZE_KEYCHAIN_PROFILE=codecast electron-builder -m`.

## Signing identity

Signing happens before this hook, from the electron-builder config
(`mac.identity`, for example `"Ashot Petrosian (WRG9THCK9Q)"`). The identity's
Team ID must equal `update.teamId` in the desktop config: the updater refuses
any downloaded bundle whose `codesign -dvv` output lacks
`TeamIdentifier=<teamId>`, so a build signed by another team can never swap
itself in.

## Entitlements

`entitlements.mac.plist` next to this file enables JIT, unsigned executable
memory (both needed by Chromium under the hardened runtime), microphone and
camera. Copy it and trim it if the app never captures audio or video.

## Checks

```sh
codesign --verify --strict --deep dist/mac-arm64/<Product>.app
spctl -a -vv dist/mac-arm64/<Product>.app          # "accepted, source=Notarized Developer ID"
xcrun stapler validate dist/mac-arm64/<Product>.app
```
