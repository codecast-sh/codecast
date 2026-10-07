// electron-builder afterSign hook factory. Notarizes the macOS bundle with the
// first credential the environment provides:
//   1. an App Store Connect API key (APPLE_API_KEY, the .p8 path, with
//      APPLE_API_KEY_ID and APPLE_API_ISSUER). Read from a file, so it needs no
//      keychain and survives Apple ID password changes;
//   2. a keychain profile (NOTARIZE_KEYCHAIN_PROFILE, made once with
//      `xcrun notarytool store-credentials` from an interactive session);
//   3. an Apple ID + app password (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID).
// With none it skips loudly, so a local build still produces an app and a
// release build cannot pass silently unnotarized without a line in the log
// saying so.
//
// `@electron/notarize` is required lazily: tests and non-mac builds never load it.

const NOTARIZE_ENV = Object.freeze({
  apiKey: "APPLE_API_KEY",
  apiKeyId: "APPLE_API_KEY_ID",
  apiIssuer: "APPLE_API_ISSUER",
  keychainProfile: "NOTARIZE_KEYCHAIN_PROFILE",
  appleId: "APPLE_ID",
  applePassword: "APPLE_PASSWORD",
  appleTeamId: "APPLE_TEAM_ID",
});

// Pure: which credential source the environment provides, if any.
function notarizeCredentials(env = process.env) {
  if (env[NOTARIZE_ENV.apiKey] && env[NOTARIZE_ENV.apiKeyId] && env[NOTARIZE_ENV.apiIssuer]) {
    return {
      kind: "apiKey",
      appleApiKey: env[NOTARIZE_ENV.apiKey],
      appleApiKeyId: env[NOTARIZE_ENV.apiKeyId],
      appleApiIssuer: env[NOTARIZE_ENV.apiIssuer],
    };
  }
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
      log(`Skipping notarization: set ${NOTARIZE_ENV.apiKey}/${NOTARIZE_ENV.apiKeyId}/${NOTARIZE_ENV.apiIssuer}, ${NOTARIZE_ENV.keychainProfile}, or ${NOTARIZE_ENV.appleId}/${NOTARIZE_ENV.applePassword}`);
      return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = `${appOutDir}/${appName}.app`;
    log(`Notarizing ${appName}...`);

    const run = notarize || require("@electron/notarize").notarize;
    if (creds.kind === "apiKey") {
      await run({ appPath, appleApiKey: creds.appleApiKey, appleApiKeyId: creds.appleApiKeyId, appleApiIssuer: creds.appleApiIssuer });
    } else if (creds.kind === "keychainProfile") {
      await run({ appPath, keychainProfile: creds.keychainProfile });
    } else {
      await run({ appPath, appleId: creds.appleId, appleIdPassword: creds.appleIdPassword, teamId: creds.teamId });
    }

    log("Notarization complete");
  };
}

module.exports = { createNotarizeHook, notarizeCredentials, NOTARIZE_ENV };
