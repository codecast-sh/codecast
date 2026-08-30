// Run: node --test packages/electron/osNotificationState.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseNotificationState, notificationSettingsUrl } = require("./osNotificationState");

// Shaped like real plutil -convert xml1 output: alphabetical keys per app
// dict, so flags follows bundle-id inside the same dict.
function entry(bundleId, flags) {
  return `
      <dict>
        <key>auth</key><integer>7</integer>
        <key>bundle-id</key>
        <string>${bundleId}</string>
        ${flags == null ? "" : `<key>flags</key>\n        <integer>${flags}</integer>`}
        <key>path</key><string>/Applications/X.app</string>
      </dict>`;
}

function plist(...entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>apps</key><array>${entries.join("")}</array></dict></plist>`;
}

test("allowed bit set → granted", () => {
  // 0x280200e — real flags observed for Chrome/Slack (allowed).
  const xml = plist(entry("sh.codecast.desktop", 0x280200e));
  assert.equal(parseNotificationState(xml, "sh.codecast.desktop"), "granted");
});

test("allowed bit clear → off", () => {
  // 0x80200e — real flags observed for denied/unanswered apps.
  const xml = plist(entry("sh.codecast.desktop", 0x80200e));
  assert.equal(parseNotificationState(xml, "sh.codecast.desktop"), "off");
});

test("no entry → ask (macOS never prompted)", () => {
  const xml = plist(entry("com.google.Chrome", 0x280200e));
  assert.equal(parseNotificationState(xml, "sh.codecast.desktop"), "ask");
});

test("flags wider than 32 bits keep bit 25 readable", () => {
  // Values above 2^32 exist in the wild (0x23088200e); 32-bit truncation in
  // the bitwise check must still read bit 25 correctly.
  const xml = plist(entry("sh.codecast.desktop", 0x10280200e));
  assert.equal(parseNotificationState(xml, "sh.codecast.desktop"), "granted");
});

test("an entry with no flags key never steals the next entry's flags", () => {
  const xml = plist(entry("sh.codecast.desktop", null), entry("com.google.Chrome", 0x280200e));
  assert.equal(parseNotificationState(xml, "sh.codecast.desktop"), "ask");
});

test("prefix bundle ids don't cross-match", () => {
  const xml = plist(entry("sh.codecast.desktop.helper", 0x280200e));
  assert.equal(parseNotificationState(xml, "sh.codecast.desktop"), "ask");
});

test("settings deep link targets the app's notification pane", () => {
  assert.equal(
    notificationSettingsUrl("sh.codecast.desktop"),
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=sh.codecast.desktop",
  );
});
