// Run: node --test packages/electron/shellRecovery.main.test.js
//
// A main window that cannot draw the app shows the recovery page and its
// Reload button, never the bare window background.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness } = require("./mainTestRig");
const { recoveryPageUrl, isRecoveryUrl } = require("./shellRecovery");

beforeEach(harness.setup);
afterEach(harness.teardown);

function pageOf(url) {
  assert.ok(isRecoveryUrl(url), `expected the recovery page, got ${url.slice(0, 80)}`);
  return decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));
}

const failLoad = (win, url) => win.webContents.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", url, true);

test("when every load retry fails, the window shows the recovery page pointed back at the app", async () => {
  const rig = harness.loadShell();
  const win = rig.mainWindow;
  const appUrl = win.last("loadURL")[0];
  for (let i = 0; i < 10; i++) {
    failLoad(win, appUrl);
    await new Promise((r) => setTimeout(r, 520));
    if (isRecoveryUrl(win.last("loadURL")[0])) break;
  }
  const html = pageOf(win.last("loadURL")[0]);
  assert.match(html, /Codecast couldn’t load/);
  assert.match(html, /<button id="reload"/);
  assert.ok(html.includes(JSON.stringify(appUrl)), "Reload goes back to the page that failed");

  // The recovery page finishing its own load is not the app arriving.
  win.webContents.emit("did-finish-load");
  assert.ok(isRecoveryUrl(win.last("loadURL")[0]));

  // Reload starts a fresh budget: one failure retries the app, not the page.
  failLoad(win, appUrl);
  await new Promise((r) => setTimeout(r, 520));
  assert.equal(win.last("loadURL")[0], appUrl);
});

test("a crashed renderer shows the recovery page for the page it was on; a clean exit does not", () => {
  const rig = harness.loadShell();
  const win = rig.mainWindow;
  win.webContents.emit("did-navigate", {}, "https://codecast.sh/conversation/abc");
  win.webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
  assert.ok(!isRecoveryUrl(win.last("loadURL")[0]));

  win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  const html = pageOf(win.last("loadURL")[0]);
  assert.match(html, /This window crashed/);
  assert.ok(html.includes('"https://codecast.sh/conversation/abc"'));
});

test("the page escapes the URL it embeds", () => {
  const html = pageOf(recoveryPageUrl("offline", 'https://x.test/"</script><b>'));
  assert.ok(!html.includes("</script><b>"));
});
