// Run: node --test packages/electron/smokeTest.test.js
//
// CI judges a Windows build by the report --smoke-test writes, so the report
// must say ok only when the app's page really loaded and a screenshot exists,
// and must still be written (with the reason) when either fails.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { smokeTestOptions, runSmokeTest } = require("./smokeTest");

function fakeWindow({ png = Buffer.from([0x89, 0x50, 0x4e, 0x47]) } = {}) {
  const contents = new EventEmitter();
  contents.url = "";
  contents.loading = true;
  contents.getURL = () => contents.url;
  contents.getTitle = () => "Codecast";
  contents.isLoadingMainFrame = () => contents.loading;
  contents.drawn = true;
  contents.executeJavaScript = async () => contents.drawn;
  contents.load = (url) => { contents.url = url; contents.loading = false; contents.emit("did-finish-load"); };
  return { webContents: contents, capturePage: async () => ({ toPNG: () => png }) };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
const readReport = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));

test("the flag is read from argv, with a default dir and timeout", () => {
  assert.equal(smokeTestOptions(["Codecast.exe", "codecast://open/inbox"]), null);
  assert.deepEqual(smokeTestOptions(["x", "--smoke-test=C:/out"]), { dir: path.resolve("C:/out"), timeoutMs: 60_000 });
  assert.deepEqual(smokeTestOptions(["x", "--smoke-test", "--smoke-timeout=90"]), { dir: path.resolve("smoke-test"), timeoutMs: 90_000 });
  assert.equal(smokeTestOptions(["x", "--smoke-test", "--smoke-timeout=nope"]).timeoutMs, 60_000);
});

test("a page that loads gives ok, a screenshot and a report", async () => {
  const dir = tmp();
  const win = fakeWindow();
  setTimeout(() => win.webContents.load("https://codecast.sh/inbox"), 10);
  const report = await runSmokeTest(win, { dir, timeoutMs: 1000, settleMs: 0, info: { version: "1.1.140", platform: "win32" } });
  assert.equal(report.ok, true);
  assert.equal(report.url, "https://codecast.sh/inbox");
  assert.equal(report.version, "1.1.140");
  assert.ok(fs.statSync(path.join(dir, "screenshot.png")).size > 0);
  assert.deepEqual(readReport(dir), report);
});

test("a page already loaded before the check starts still counts", async () => {
  const dir = tmp();
  const win = fakeWindow();
  win.webContents.load("https://codecast.sh/inbox");
  assert.equal((await runSmokeTest(win, { dir, timeoutMs: 200, settleMs: 0 })).ok, true);
});

test("the recovery page is not a load: the check times out with the URL it saw", async () => {
  const dir = tmp();
  const win = fakeWindow();
  setTimeout(() => win.webContents.load("data:text/html,recovery"), 10);
  const report = await runSmokeTest(win, { dir, timeoutMs: 100, settleMs: 0, isLoaded: (u) => u.startsWith("https://") });
  assert.equal(report.ok, false);
  assert.match(report.error, /did not load within 100 ms \(at data:text\/html,recovery\)/);
  // The screenshot of what it did show is still saved: that is the evidence.
  assert.ok(report.screenshot);
  assert.equal(readReport(dir).ok, false);
});

test("an empty capture fails the check even when the page loaded", async () => {
  const dir = tmp();
  const win = fakeWindow({ png: Buffer.alloc(0) });
  win.webContents.load("https://codecast.sh/inbox");
  const report = await runSmokeTest(win, { dir, timeoutMs: 200, settleMs: 0 });
  assert.equal(report.ok, false);
  assert.match(report.error, /screenshot: empty capture/);
  assert.equal(report.screenshot, null);
});

test("a page stuck on its boot screen fails, and one that draws late passes", async () => {
  const stuck = fakeWindow();
  stuck.webContents.drawn = false;
  stuck.webContents.load("https://codecast.sh/inbox");
  const report = await runSmokeTest(stuck, { dir: tmp(), timeoutMs: 300, settleMs: 0 });
  assert.equal(report.ok, false);
  assert.match(report.error, /never drew past its boot screen/);

  const late = fakeWindow();
  late.webContents.drawn = false;
  late.webContents.load("https://codecast.sh/inbox");
  setTimeout(() => { late.webContents.drawn = true; }, 100);
  assert.equal((await runSmokeTest(late, { dir: tmp(), timeoutMs: 2000, settleMs: 0 })).ok, true);
});
