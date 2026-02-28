const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const useKeychainProfile = process.env.NOTARIZE_KEYCHAIN_PROFILE;
  const useAppleId = process.env.APPLE_ID && process.env.APPLE_PASSWORD;

  if (!useKeychainProfile && !useAppleId) {
    console.log("Skipping notarization: set NOTARIZE_KEYCHAIN_PROFILE or APPLE_ID/APPLE_PASSWORD");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`Notarizing ${appName}...`);

  if (useKeychainProfile) {
    await notarize({
      appPath,
      keychainProfile: useKeychainProfile,
    });
  } else {
    await notarize({
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: "WRG9THCK9Q",
    });
  }

  console.log("Notarization complete");
};
