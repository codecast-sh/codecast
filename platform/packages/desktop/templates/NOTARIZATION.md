# Notarization

The afterSign hook (`createNotarizeHook`) reads its credentials from the
environment. It notarizes only macOS builds, and it skips with a printed line
when it finds no credentials. A release build must show "Notarization complete"
in its log.

## Environment variables

One of the two sources is required.

| Variable | Use |
| --- | --- |
| `NOTARIZE_KEYCHAIN_PROFILE` | Name of a notarytool keychain profile. Preferred. Wins when both sources are set. |
| `APPLE_ID` | Apple ID email. Used with `APPLE_PASSWORD`. |
| `APPLE_PASSWORD` | An app specific password for that Apple ID, not the account password. |
| `APPLE_TEAM_ID` | The 10 character Team ID. Optional with the keychain profile; pass it with the Apple ID pair. |

## One time setup (keychain profile)

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
