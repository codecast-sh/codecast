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
  assert.deepEqual(Object.keys(addon).sort(), ["authorizationStatus", "onActivate", "post", "requestAuthorization", "windowFrame"]);
  assert.equal(addon.authorizationStatus(), -1);
  assert.equal(addon.requestAuthorization(), undefined);
  assert.equal(addon.post("title", "body"), null);
  assert.equal(addon.onActivate(() => {}), undefined);
  // A window that does not exist, or no id at all, is null rather than a throw.
  assert.equal(addon.windowFrame(0), null);
  assert.equal(addon.windowFrame(2 ** 31 - 2), null);
  assert.equal(addon.windowFrame(), null);
});

// Every notification the app shows goes through the modern API once the
// addon can post: macOS drops the legacy class from a process that has read
// its permission (2026-09-03: an update staged at 11:58 and its "ready"
// notification was denied the same second, "can't mix modern clients with
// legacy clients"). A click reaches exactly the handler of the notification
// clicked, once. The modern API is macOS only, so these two run on darwin and
// the test after them pins what every other platform gets.
const NOT_MAC = process.platform !== "darwin";

test("notify posts through the addon and routes a click to its own handler", { skip: NOT_MAC }, () => {
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

// A banner carries its click target, so a click still lands once the
// in-memory handler is gone: the app relaunched (an update) while the banner
// sat in Notification Center. The listener is wired at boot, before any post.
test("a click with no live handler goes to the boot listener with the banner's payload", { skip: NOT_MAC }, () => {
  const posted = [];
  let activate = null;
  let wired = 0;
  const addon = {
    authorizationStatus: () => 2,
    requestAuthorization: () => {},
    post: (title, body, payload) => { posted.push(payload); return `id-${posted.length}`; },
    onActivate: (cb) => { activate = cb; wired++; },
  };
  const p = createOsPermissions({ electron: stubElectron(), bundleId: APP, notifications: addon });
  const routed = [];
  assert.equal(p.listenForClicks((payload) => routed.push(payload)), true);
  assert.equal(wired, 1, "wired at boot, before any banner");
  // A banner from an earlier run: no handler here, only its payload.
  activate("id-old", '{"route":"/conversation/x"}');
  assert.deepEqual(routed, ['{"route":"/conversation/x"}']);

  // This run's banner: its own handler wins over the payload.
  const clicks = [];
  assert.equal(p.notify("A", "a", () => clicks.push("a"), '{"route":"/conversation/a"}'), true);
  assert.deepEqual(posted, ['{"route":"/conversation/a"}']);
  activate("id-1", '{"route":"/conversation/a"}');
  assert.deepEqual(clicks, ["a"]);
  assert.equal(routed.length, 1);
  // A banner with no payload and no handler does nothing.
  activate("id-none");
  assert.equal(routed.length, 1);
  // Wiring again re-claims the delegate and keeps the listener.
  p.listenForClicks();
  activate("id-old2", '{"route":"/conversation/y"}');
  assert.equal(routed.length, 2);
});

test("notify prompts first when never asked, and reports false when nothing can post", { skip: NOT_MAC }, () => {
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

test("notify never posts off macOS, even with a working addon, so the caller falls back", { skip: !NOT_MAC }, () => {
  let posts = 0;
  const addon = { authorizationStatus: () => 2, requestAuthorization: () => {}, post: () => { posts++; return "id"; }, onActivate: () => {} };
  assert.equal(createOsPermissions({ electron: stubElectron(), bundleId: APP, notifications: addon }).notify("t", "b"), false);
  assert.equal(posts, 0);
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
