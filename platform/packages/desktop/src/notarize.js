// electron-builder afterSign hook factory. Notarizes the macOS bundle with
// either a keychain profile (NOTARIZE_KEYCHAIN_PROFILE, made once with
// `xcrun notarytool store-credentials`) or an Apple ID + app password
// (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID). With neither it skips loudly, so a
// local build still produces an app and a release build cannot pass silently
// unnotarized without a line in the log saying so.
//
// `@electron/notarize` is required lazily: tests and non-mac builds never load it.

const NOTARIZE_ENV = Object.freeze({
  keychainProfile: "NOTARIZE_KEYCHAIN_PROFILE",
  appleId: "APPLE_ID",
  applePassword: "APPLE_PASSWORD",
  appleTeamId: "APPLE_TEAM_ID",
});

// Pure: which credential source the environment provides, if any.
function notarizeCredentials(env = process.env) {
  const profile = env[NOTARIZE_ENV.keychainProfile];
  if (profile) return { kind: "keychainProfile", keychainProfile: profile };
  if (env[NOTARIZE_ENV.appleId] && env[NOTARIZE_ENV.applePassword]) {
    return {
      kind: "appleId",
      appleId: env[NOTARIZE_ENV.appleId],
      appleIdPassword: env[NOTARIZE_ENV.applePassword],
      teamId: env[NOTARIZE_ENV.appleTeamId],
    };
  }
  return null;
}

function createNotarizeHook({ env = process.env, log = console.log, notarize } = {}) {
  return async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;
    if (electronPlatformName !== "darwin") return;

    const creds = notarizeCredentials(env);
    if (!creds) {
      log(`Skipping notarization: set ${NOTARIZE_ENV.keychainProfile} or ${NOTARIZE_ENV.appleId}/${NOTARIZE_ENV.applePassword}`);
      return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = `${appOutDir}/${appName}.app`;
    log(`Notarizing ${appName}...`);

    const run = notarize || require("@electron/notarize").notarize;
    if (creds.kind === "keychainProfile") {
      await run({ appPath, keychainProfile: creds.keychainProfile });
    } else {
      await run({ appPath, appleId: creds.appleId, appleIdPassword: creds.appleIdPassword, teamId: creds.teamId });
    }

    log("Notarization complete");
  };
}

module.exports = { createNotarizeHook, notarizeCredentials, NOTARIZE_ENV };
