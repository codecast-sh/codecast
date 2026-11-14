// Run: node --test packages/electron/rendererLog.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createRendererLog } = require("./rendererLog");

function fakeContents(url) {
  const c = new EventEmitter();
  c.getURL = () => url;
  return c;
}
function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-log-"));
  const log = createRendererLog({
    dir: () => dir,
    appOrigin: () => "https://codecast.sh",
    now: () => new Date("2026-11-14T00:00:00.000Z"),
    ...opts,
  });
  const read = () => { try { return fs.readFileSync(log.file(), "utf8"); } catch { return ""; } };
  return { dir, log, read };
}

test("keeps the app's warnings and errors with their window", () => {
  const { log, read } = setup();
  const win = fakeContents("https://codecast.sh/palette?x=1");
  log.attach(win);
  win.emit("console-message", { level: "warning", message: "[cache] purge", lineNumber: 12, sourceId: "https://codecast.sh/assets/index-abc.js" });
  win.emit("console-message", { level: "error", message: "durable enqueue stuck\nsecond line", lineNumber: 3, sourceId: "" });
  assert.equal(read(),
    "2026-11-14T00:00:00.000Z WARNING [/palette] [cache] purge (index-abc.js:12)\n" +
    "2026-11-14T00:00:00.000Z ERROR [/palette] durable enqueue stuck\n    second line\n");
});

test("drops info and debug lines", () => {
  const { log, read } = setup();
  const win = fakeContents("https://codecast.sh/inbox");
  log.attach(win);
  win.emit("console-message", { level: "info", message: "hello" });
  win.emit("console-message", { level: "debug", message: "noise" });
  assert.equal(read(), "");
});

test("never logs a page on another origin", () => {
  const { log, read } = setup();
  const pane = fakeContents("https://bank.example/account");
  log.attach(pane);
  pane.emit("console-message", { level: "error", message: "secret stuff" });
  assert.equal(read(), "");
});

test("reads the positional form older Electron sends", () => {
  const { log, read } = setup();
  const win = fakeContents("https://codecast.sh/inbox");
  log.attach(win);
  win.emit("console-message", {}, 2, "old style warning", 7, "https://codecast.sh/a.js");
  assert.equal(read(), "2026-11-14T00:00:00.000Z WARNING [/inbox] old style warning (a.js:7)\n");
});

test("rotates at the size cap, keeping one previous file", () => {
  const { log, read, dir } = setup({ maxBytes: 200 });
  const win = fakeContents("https://codecast.sh/inbox");
  log.attach(win);
  for (let i = 0; i < 6; i++) win.emit("console-message", { level: "error", message: `line ${i} ${"x".repeat(40)}` });
  assert.ok(fs.statSync(log.file()).size <= 200);
  assert.ok(fs.existsSync(path.join(dir, "renderer.log.1")));
  assert.match(read(), /line 5/);
});

test("a log that cannot be written never throws into the window", () => {
  const log = createRendererLog({
    dir: "/nonexistent-root-dir/x",
    appOrigin: () => "https://codecast.sh",
    fsImpl: { mkdirSync() { throw new Error("EACCES"); }, statSync() { throw new Error(); }, appendFileSync() { throw new Error(); }, renameSync() {} },
  });
  const win = fakeContents("https://codecast.sh/inbox");
  log.attach(win);
  assert.doesNotThrow(() => win.emit("console-message", { level: "error", message: "boom" }));
});
