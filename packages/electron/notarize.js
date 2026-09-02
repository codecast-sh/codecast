// electron-builder's afterSign hook (wired by build.afterSign in package.json).
//
// The hook itself is @platform/desktop's: it reads the same environment this
// file used to read — NOTARIZE_KEYCHAIN_PROFILE, or APPLE_ID + APPLE_PASSWORD
// (+ APPLE_TEAM_ID) — notarizes the built .app, and skips with a printed line
// when neither is set, so a local build still produces an app and a release
// build cannot pass silently unnotarized.
//
// `@electron/notarize` is required lazily inside the hook, so loading this file
// on a non-mac build or in a test costs nothing.

const { createNotarizeHook } = require("@platform/desktop");

exports.default = createNotarizeHook();
