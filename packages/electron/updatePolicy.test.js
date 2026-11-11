// Run: node --test packages/electron/updatePolicy.test.js
//
// The desktop updater trusts nothing the feed says on its own: a signed but
// older build announced as an upgrade, a bundle whose version differs from the
// feed's, and a zip name that walks out of the staging directory are refused.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseFeed, plistVersion, bundleRefusal } = require("./updatePolicy");

const feed = (version, zip) => `version: ${version}\nfiles:\n  - url: ${zip}\n    sha512: abc==\n    size: 1\n`;
const plist = (v) => `<?xml version="1.0"?><plist><dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${v}</string>\n</dict></plist>`;

test("today's feed parses whole", () => {
  assert.deepEqual(parseFeed(feed("1.1.128", "Codecast-1.1.128-arm64-mac.zip")), { version: "1.1.128", zip: "Codecast-1.1.128-arm64-mac.zip", sha512: "abc==" });
});

test("a zip that is not a plain file name is dropped", () => {
  for (const zip of ["../../evil-mac.zip", "/tmp/evil-mac.zip", "sub/dir-mac.zip", "..-mac.zip", "a..b-mac.zip"]) {
    assert.equal(parseFeed(feed("1.1.129", zip)).zip, undefined, zip);
  }
});

test("the bundle's own version is read from Info.plist", () => {
  assert.equal(plistVersion(plist("1.1.129")), "1.1.129");
  assert.equal(plistVersion("<plist><dict></dict></plist>"), null);
  assert.equal(plistVersion(plist("1.1.129; rm")), null);
});

test("a signed older build announced as an upgrade is refused", () => {
  assert.match(bundleRefusal({ feedVersion: "9.0.0", bundleVersion: "1.1.100", runningVersion: "1.1.128" }), /feed announced/);
  assert.match(bundleRefusal({ feedVersion: "1.1.100", bundleVersion: "1.1.100", runningVersion: "1.1.128" }), /not newer/);
  assert.match(bundleRefusal({ feedVersion: "1.1.100", bundleVersion: "1.1.100", runningVersion: "1.1.128", force: true }), /not newer/);
  assert.match(bundleRefusal({ feedVersion: "1.1.129", bundleVersion: null, runningVersion: "1.1.128" }), /no readable version/);
});

test("a newer bundle matching the feed installs, and a forced check may reinstall the running version", () => {
  assert.equal(bundleRefusal({ feedVersion: "1.1.129", bundleVersion: "1.1.129", runningVersion: "1.1.128" }), null);
  assert.equal(bundleRefusal({ feedVersion: "1.1.128", bundleVersion: "1.1.128", runningVersion: "1.1.128", force: true }), null);
  assert.match(bundleRefusal({ feedVersion: "1.1.128", bundleVersion: "1.1.128", runningVersion: "1.1.128" }), /not newer/);
});
