// What the desktop updater accepts from the feed, as pure functions so they
// test without a packaged app. The feed (latest-mac.yml) and the zip come from
// the same bucket, so nothing the feed says is trusted on its own: the zip
// name must be a plain file name, and the bundle inside, already held to our
// Apple team's signature, must carry the version the feed announced and be
// newer than the running one. A signed build is never a downgrade.

function cmpVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

const VERSION = /^\d+(\.\d+){1,3}$/;
const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*-mac\.zip$/;

// Parse only the fields we need from latest-mac.yml (no YAML dependency).
// A zip that is not a plain file name in the feed's own directory is dropped.
function parseFeed(text) {
  const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  let zip, sha512;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/url:\s*(\S+-mac\.zip)\s*$/);
    if (m) {
      zip = m[1].trim();
      const sm = lines[i + 1]?.match(/sha512:\s*(\S+)\s*$/);
      if (sm) sha512 = sm[1].trim();
      break;
    }
  }
  if (zip && (!ZIP_NAME.test(zip) || zip.includes(".."))) zip = undefined;
  return { version: version && VERSION.test(version) ? version : undefined, zip, sha512 };
}

// CFBundleShortVersionString from an XML Info.plist, or null.
function plistVersion(xml) {
  const v = String(xml).match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.trim();
  return v && VERSION.test(v) ? v : null;
}

// Why an extracted bundle may not replace the running app, or null. A forced
// check may reinstall the running version, never an older one.
function bundleRefusal({ feedVersion, bundleVersion, runningVersion, force = false }) {
  if (!bundleVersion) return "bundle has no readable version";
  if (cmpVersions(bundleVersion, feedVersion) !== 0) return `bundle is ${bundleVersion}, feed announced ${feedVersion}`;
  const vsRunning = cmpVersions(bundleVersion, runningVersion);
  if (vsRunning < 0 || (vsRunning === 0 && !force)) return `bundle ${bundleVersion} is not newer than running ${runningVersion}`;
  return null;
}

module.exports = { cmpVersions, parseFeed, plistVersion, bundleRefusal };
