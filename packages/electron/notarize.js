const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;
  if (!process.env.APPLE_ID || !process.env.APPLE_PASSWORD) {
    console.log("Skipping notarization: APPLE_ID/APPLE_PASSWORD not set");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`Notarizing ${appName}...`);

  await notarize({
    appBundleId: "sh.codecast.desktop",
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_PASSWORD,
    teamId: "WRG9THCK9Q",
  });

  console.log("Notarization complete");
};
