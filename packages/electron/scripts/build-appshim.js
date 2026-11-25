// electron-builder's beforePack hook (build.beforePack in package.json): builds
// the installed-app shim (appshim/build.sh, a universal arm64 + x86_64
// binary) before a macOS app is packed, so mac.extraResources can ship it at
// Contents/Resources/appshim/CodecastAppShim. electron-builder's signer
// (@electron/osx-sign) signs every Mach-O it finds inside the app, Resources
// included, with the app's Developer ID, hardened runtime and a timestamp,
// which is what notarization needs; install.js re-seals each copy ad hoc.
//
// build.sh is a no-op when the binary is newer than its sources. Other
// platforms skip: the shim is macOS-only.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const BUILD = path.join(__dirname, "..", "appshim", "build.sh");
const BINARY = path.join(__dirname, "..", "appshim", "build", "CodecastAppShim");

async function beforePack(context) {
  if (context && context.electronPlatformName && context.electronPlatformName !== "darwin") return;
  execFileSync(BUILD, { stdio: "inherit" });
}

module.exports = beforePack;
module.exports.default = beforePack;
module.exports.BINARY = BINARY;

if (require.main === module) beforePack({ electronPlatformName: process.platform }).catch((err) => {
  console.error(err);
  process.exit(1);
});
