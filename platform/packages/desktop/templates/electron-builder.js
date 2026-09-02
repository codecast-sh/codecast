// electron-builder config template. Copy or require it from the app's
// `electron-builder.config.js`:
//
//   module.exports = require("@platform/desktop/templates/electron-builder")({
//     appId: "sh.codecast.desktop",
//     productName: "Codecast",
//     protocol: "codecast",
//     publishUrl: "https://dl.codecast.sh/desktop",
//     identity: "Ashot Petrosian (WRG9THCK9Q)",
//     microphoneUsage: "Codecast uses the microphone for team huddles.",
//     cameraUsage: "Codecast uses the camera for team huddles.",
//     files: ["main.js", "assets/icon.png", "assets/trayTemplate.png", "assets/trayTemplate@2x.png"],
//   });
//
// and run `electron-builder -m --config electron-builder.config.js`.
//
// The afterSign hook is the package's notarize factory. It reads credentials
// from the environment (see NOTARIZATION.md) and skips loudly without them.
//
// `files` must list every local file main.js requires plus the shell package:
// a require missing from the asar ships an app that dies at boot (codecast
// v1.1.85). The package's own sources are added here so you cannot forget them.

const path = require("path");
const { createNotarizeHook } = require("../src/notarize");

const ENTITLEMENTS = path.join(__dirname, "entitlements.mac.plist");

function electronBuilderConfig(opts) {
  const required = ["appId", "productName", "protocol", "publishUrl", "identity"];
  for (const k of required) {
    if (!opts || typeof opts[k] !== "string" || !opts[k]) throw new Error(`electron-builder template: ${k} is required`);
  }
  const {
    appId,
    productName,
    protocol,
    publishUrl,
    identity,
    files = [],
    buildResources = "assets",
    icon = "assets/icon.icns",
    entitlements = ENTITLEMENTS,
    category = "public.app-category.developer-tools",
    minimumSystemVersion = "10.15",
    microphoneUsage,
    cameraUsage,
    targets = ["dmg", "zip"],
    arch = "arm64",
    extraMac = {},
  } = opts;

  const extendInfo = {};
  if (microphoneUsage) extendInfo.NSMicrophoneUsageDescription = microphoneUsage;
  if (cameraUsage) extendInfo.NSCameraUsageDescription = cameraUsage;

  return {
    appId,
    productName,
    files: [
      ...files,
      // The shell itself. The preload and every module it requires must be in
      // the asar; the package is small, so ship all of src.
      "node_modules/@platform/desktop/src/**",
      "node_modules/@platform/desktop/package.json",
    ],
    directories: { buildResources },
    afterSign: createNotarizeHook(),
    mac: {
      target: targets,
      category,
      icon,
      darkModeSupport: true,
      minimumSystemVersion,
      identity,
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements,
      entitlementsInherit: entitlements,
      extendInfo,
      ...extraMac,
    },
    dmg: {
      title: productName,
      artifactName: `${productName}-\${version}-${arch}.\${ext}`,
    },
    protocols: [{ name: productName, schemes: [protocol] }],
    // The generic provider publishes <channel>-mac.yml + the zip/dmg. The
    // updater reads `${publishUrl}/latest-mac.yml` (or `<channel>-mac.yml`).
    publish: { provider: "generic", url: publishUrl },
  };
}

module.exports = electronBuilderConfig;
module.exports.electronBuilderConfig = electronBuilderConfig;
module.exports.ENTITLEMENTS = ENTITLEMENTS;
