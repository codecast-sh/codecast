// Run: node --test packages/electron/osPermissions.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  KINDS,
  authorizationStatusToReadiness,
  mediaStatusToReadiness,
  settingsUrl,
  createOsPermissions,
} = require("./osPermissions");

const APP = "sh.codecast.desktop";

test("UNAuthorizationStatus vocabulary maps onto readiness", () => {
  assert.equal(authorizationStatusToReadiness(0), "ask"); // notDetermined
  assert.equal(authorizationStatusToReadiness(1), "off"); // denied
  assert.equal(authorizationStatusToReadiness(2), "granted"); // authorized
  assert.equal(authorizationStatusToReadiness(3), "granted"); // provisional
  assert.equal(authorizationStatusToReadiness(4), "granted"); // ephemeral
  assert.equal(authorizationStatusToReadiness(-1), "unknown"); // addon: no answer
  assert.equal(authorizationStatusToReadiness(undefined), "unknown");
});

test("the built addon answers from inside an app bundle and never throws outside one", () => {
  // Plain node has no bundle: UNUserNotificationCenter would throw, the addon
  // must report "no answer" instead. Skipped when the binary isn't built.
  let addon;
  try {
    addon = require("./native/notifications.node");
  } catch {
    return;
  }
  assert.deepEqual(Object.keys(addon).sort(), ["authorizationStatus", "onActivate", "post", "requestAuthorization"]);
  assert.equal(addon.authorizationStatus(), -1);
  assert.equal(addon.requestAuthorization(), undefined);
  assert.equal(addon.post("title", "body"), null);
  assert.equal(addon.onActivate(() => {}), undefined);
});

// Every notification the app shows goes through the modern API once the
// addon can post: macOS drops the legacy class from a process that has read
// its permission (2026-09-03: an update staged at 11:58 and its "ready"
// notification was denied the same second, "can't mix modern clients with
// legacy clients"). A click reaches exactly the handler of the notification
// clicked, once.
test("notify posts through the addon and routes a click to its own handler", () => {
  const posted = [];
  let activate = null;
  let asked = 0;
  const addon = {
    authorizationStatus: () => 2,
    requestAuthorization: () => { asked++; },
    post: (title, body) => { posted.push({ title, body }); return `id-${posted.length}`; },
    onActivate: (cb) => { activate = cb; },
  };
  const p = createOsPermissions({ electron: stubElectron(), bundleId: APP, notifications: addon });
  const clicks = [];
  assert.equal(p.notify("A", "first", () => clicks.push("a")), true);
  assert.equal(p.notify("B", "second", () => clicks.push("b")), true);
  assert.equal(p.notify("C", "no handler"), true);
  assert.deepEqual(posted.map((x) => x.title), ["A", "B", "C"]);
  assert.equal(asked, 0, "already authorized: no prompt");
  activate("id-2");
  activate("id-2");
  activate("id-3");
  assert.deepEqual(clicks, ["b"]);
});

test("notify prompts first when never asked, and reports false when nothing can post", () => {
  let asked = 0;
  const addon = {
    authorizationStatus: () => 0,
    requestAuthorization: () => { asked++; },
    post: () => "id",
    onActivate: () => {},
  };
  const p = createOsPermissions({ electron: stubElectron(), bundleId: APP, notifications: addon });
  assert.equal(p.notify("t", "b"), true);
  assert.equal(asked, 1);
  // No addon, or an addon built before `post` existed: the caller falls back.
  assert.equal(createOsPermissions({ electron: stubElectron(), bundleId: APP, notifications: null }).notify("t", "b"), false);
  const old = { authorizationStatus: () => 2, requestAuthorization: () => {} };
  assert.equal(createOsPermissions({ electron: stubElectron(), bundleId: APP, notifications: old }).notify("t", "b"), false);
  // A post that returns nothing (outside a bundle) is not a delivery.
  const mute = { ...addon, post: () => null };
  assert.equal(createOsPermissions({ electron: stubElectron(), bundleId: APP, notifications: mute }).notify("t", "b"), false);
});

function stubElectron() {
  return {
    systemPreferences: { getMediaAccessStatus: () => "granted", askForMediaAccess: async () => true },
    desktopCapturer: { getSources: async () => [] },
    shell: { openExternal: () => {} },
  };
}

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

// A fake electron + notifications addon: records what the shell would have
// done. `status.notifications` is the UNAuthorizationStatus the addon reports.
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
    notifications: {
      authorizationStatus: () => status.notifications,
      requestAuthorization: () => log.push("request:notifications"),
    },
  };
}

function permissions(f) {
  return createOsPermissions({ electron: f.electron, bundleId: APP, notifications: f.notifications });
}

test("getAll: notifications come from the addon, media from systemPreferences", async () => {
  if (process.platform !== "darwin") return;
  const f = fakeElectron({ notifications: 2, microphone: "granted", camera: "not-determined", screen: "denied" });
  assert.deepEqual(await permissions(f).getAll(), {
    notifications: "granted",
    microphone: "granted",
    camera: "ask",
    screen: "off",
  });
});

test("getAll: no addon (unbuilt, non-mac build) → notifications unknown, never a nag", async () => {
  if (process.platform !== "darwin") return;
  const f = fakeElectron({ microphone: "granted" });
  const p = createOsPermissions({ electron: f.electron, bundleId: APP, notifications: null });
  assert.equal((await p.getAll()).notifications, "unknown");
});

test("getAll: an addon that throws reads as unknown", async () => {
  if (process.platform !== "darwin") return;
  const f = fakeElectron({});
  f.notifications.authorizationStatus = () => { throw new Error("boom"); };
  assert.equal((await permissions(f).getAll()).notifications, "unknown");
});

test("request: mic/camera ask the OS and report its answer", async () => {
  if (process.platform !== "darwin") return;
  const f = fakeElectron({ microphone: "not-determined", camera: "denied" });
  const p = permissions(f);
  assert.equal(await p.request("microphone"), "granted");
  assert.equal(await p.request("camera"), "off");
  assert.deepEqual(f.log, ["ask:microphone", "ask:camera"]);
});

test("request: notifications raise the OS prompt; screen captures once then opens the pane", async () => {
  if (process.platform !== "darwin") return;
  const f = fakeElectron({});
  const p = permissions(f);
  assert.equal(await p.request("notifications"), "ask");
  assert.equal(await p.request("screen"), "ask");
  assert.deepEqual(f.log, ["request:notifications", "capture", `open:${settingsUrl("screen", APP)}`]);
});

test("openSettings goes to the kind's pane", () => {
  const f = fakeElectron({});
  permissions(f).openSettings("camera");
  assert.deepEqual(f.log, [`open:${settingsUrl("camera", APP)}`]);
});
