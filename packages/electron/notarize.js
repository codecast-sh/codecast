// electron-builder's afterSign hook (wired by build.afterSign in package.json).
//
// The hook itself is @platform/desktop's: it notarizes the built .app with an
// App Store Connect API key, else NOTARIZE_KEYCHAIN_PROFILE, else APPLE_ID +
// APPLE_PASSWORD (+ APPLE_TEAM_ID), and skips with a printed line when none is
// set, so a local build still produces an app and a release build cannot pass
// silently unnotarized.
//
// The API key is the team's "Agent" key, the one mobile's EAS submit reads
// (packages/mobile/eas.json). A key file needs no keychain, so a release works
// from an agent shell, where a keychain write fails with "User interaction is
// not allowed", and it survives Apple ID password changes, which revoke app
// specific passwords. It goes to the hook's env, not process.env: electron-
// builder notarizes on its own when it sees APPLE_API_KEY, which would run
// notarization twice.
//
// `@electron/notarize` is required lazily inside the hook, so loading this file
// on a non-mac build or in a test costs nothing.

const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { createNotarizeHook } = require("@platform/desktop");

const AGENT_KEY = {
  APPLE_API_KEY: join(homedir(), ".app-store-connect", "AuthKey_KR5Y6LS448.p8"),
  APPLE_API_KEY_ID: "KR5Y6LS448",
  APPLE_API_ISSUER: "69a6de76-856e-47e3-e053-5b8c7c11a4d1",
};

exports.default = createNotarizeHook({
  env: existsSync(AGENT_KEY.APPLE_API_KEY) ? { ...process.env, ...AGENT_KEY } : process.env,
});
