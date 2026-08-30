// Run: node --test packages/electron/osPermissions.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  KINDS,
  parseNotificationState,
  mediaStatusToReadiness,
  settingsUrl,
  createOsPermissions,
} = require("./osPermissions");

const APP = "sh.codecast.desktop";

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

test("notifications: allowed bit set → granted", () => {
  // 0x280200e — real flags observed for Chrome/Slack (allowed).
  assert.equal(parseNotificationState(plist(entry(APP, 0x280200e)), APP), "granted");
});

test("notifications: allowed bit clear → off", () => {
  // 0x80200e — real flags observed for denied/unanswered apps.
  assert.equal(parseNotificationState(plist(entry(APP, 0x80200e)), APP), "off");
});

test("notifications: no entry → ask (macOS never prompted)", () => {
  assert.equal(parseNotificationState(plist(entry("com.google.Chrome", 0x280200e)), APP), "ask");
});

test("notifications: flags wider than 32 bits keep bit 25 readable", () => {
  // Values above 2^32 exist in the wild (0x23088200e); 32-bit truncation in
  // the bitwise check must still read bit 25 correctly.
  assert.equal(parseNotificationState(plist(entry(APP, 0x10280200e)), APP), "granted");
});

test("notifications: an entry with no flags key never steals the next entry's flags", () => {
  const xml = plist(entry(APP, null), entry("com.google.Chrome", 0x280200e));
  assert.equal(parseNotificationState(xml, APP), "ask");
});

test("notifications: prefix bundle ids don't cross-match", () => {
  assert.equal(parseNotificationState(plist(entry(`${APP}.helper`, 0x280200e)), APP), "ask");
});

test("media status vocabulary maps onto readiness", () => {
  assert.equal(mediaStatusToReadiness("granted"), "granted");
  assert.equal(mediaStatusToReadiness("not-determined"), "ask");
  assert.equal(mediaStatusToReadiness("denied"), "off");
  assert.equal(mediaStatusToReadiness("restricted"), "off");
  assert.equal(mediaStatusToReadiness("unknown"), "unknown");
  assert.equal(mediaStatusToReadiness(undefined), "unknown");
});

test("every kind has a System Settings pane", () => {
  for (const k of KINDS) assert.ok(settingsUrl(k, APP), k);
  assert.equal(
    settingsUrl("notifications", APP),
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=sh.codecast.desktop",
  );
  assert.match(settingsUrl("screen", APP), /Privacy_ScreenCapture$/);
  assert.equal(settingsUrl("bogus", APP), null);
});

// A fake electron: records what the shell would have done.
function fakeElectron(status) {
  const log = [];
  return {
    log,
    electron: {
      systemPreferences: {
        getMediaAccessStatus: (k) => status[k],
        askForMediaAccess: async (k) => { log.push(`ask:${k}`); return status[k] === "not-determined"; },
      },
      desktopCapturer: { getSources: async () => { log.push("capture"); return []; } },
      shell: { openExternal: (u) => log.push(`open:${u}`) },
    },
  };
}

test("request: mic/camera ask the OS and report its answer", async () => {
  if (process.platform !== "darwin") return;
  const f = fakeElectron({ microphone: "not-determined", camera: "denied" });
  const p = createOsPermissions({ electron: f.electron, bundleId: APP, showNotification: () => f.log.push("notify") });
  assert.equal(await p.request("microphone"), "granted");
  assert.equal(await p.request("camera"), "off");
  assert.deepEqual(f.log, ["ask:microphone", "ask:camera"]);
});

test("request: notifications post a banner; screen captures once then opens the pane", async () => {
  if (process.platform !== "darwin") return;
  const f = fakeElectron({});
  const p = createOsPermissions({ electron: f.electron, bundleId: APP, showNotification: () => f.log.push("notify") });
  assert.equal(await p.request("notifications"), "ask");
  assert.equal(await p.request("screen"), "ask");
  assert.deepEqual(f.log, ["notify", "capture", `open:${settingsUrl("screen", APP)}`]);
});

test("openSettings goes to the kind's pane", () => {
  const f = fakeElectron({});
  const p = createOsPermissions({ electron: f.electron, bundleId: APP, showNotification: () => {} });
  p.openSettings("camera");
  assert.deepEqual(f.log, [`open:${settingsUrl("camera", APP)}`]);
});
