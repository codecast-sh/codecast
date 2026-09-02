// Run: node --test packages/electron/preload.sandbox.test.js
//
// The preload must come up in the real renderer, under the preferences every
// window in main.js gives it.
//
// preload.js is a Node module: it requires @platform/desktop. Electron sandboxes
// a renderer by default whenever nodeIntegration is off, and a sandboxed
// preload only has a polyfilled `require` (electron, events, timers, url), so
// under the default the preload died on its second line and the bridge global
// never appeared. Nothing else failed loudly: the page simply ran as if in a
// browser, with no titlebar inset, no back/forward and no updater. That shipped
// as desktop 1.1.100, and from-source verification passed the whole way,
// which is why this test starts a real Electron rather than the recorder rig.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const HERE = __dirname;
const MAIN = readFileSync(join(HERE, "main.js"), "utf8");

test("every window main.js builds takes its preload from preloadPrefs()", () => {
  // A window that spells the preload out by hand gets Electron's default
  // sandbox, and with it a preload that cannot load.
  const windows = MAIN.match(/webPreferences: \{/g) ?? [];
  const shared = MAIN.match(/\.\.\.preloadPrefs\(\)/g) ?? [];
  assert.ok(windows.length > 0);
  assert.equal(shared.length, windows.length, "a webPreferences block does not spread preloadPrefs()");
  assert.match(MAIN, /function preloadPrefs\(\) \{[^}]*sandbox: false/);
});

// The probe runs inside Electron: one hidden window with the real preload, and
// a report of whether it threw and whether the bridge global exists on the
// page. One launch per case — a second window in the same process fails its
// load with ERR_FAILED whatever the order. The window is never shown.
const PROBE = `
const { app, BrowserWindow } = require("electron");
const preload = ${JSON.stringify(join(HERE, "preload.js"))};
async function probe(prefs) {
  const win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, ...prefs } });
  let preloadError = null;
  win.webContents.on("preload-error", (_e, _p, err) => { preloadError = err.message; });
  await win.loadURL("data:text/html,<p>probe</p>");
  const bridge = await win.webContents.executeJavaScript("typeof window.__CODECAST_ELECTRON__");
  win.destroy();
  return { preloadError, bridge };
}
app.whenReady().then(async () => {
  const out = await probe(JSON.parse(process.argv[process.argv.length - 1]));
  process.stdout.write("PROBE " + JSON.stringify(out) + "\\n");
  app.exit(0);
}).catch((e) => { process.stdout.write("PROBE " + JSON.stringify({ error: String(e) }) + "\\n"); app.exit(1); });
`;

function runProbe(prefs) {
  const file = join(os.tmpdir(), `codecast-preload-probe-${process.pid}.js`);
  writeFileSync(file, PROBE);
  const electron = require("electron");
  return new Promise((resolve, reject) => {
    execFile(electron, [file, JSON.stringify(prefs)], { timeout: 60_000 }, (err, stdout, stderr) => {
      const line = String(stdout).split("\n").find((l) => l.startsWith("PROBE "));
      if (!line) return reject(new Error(`no probe report\n${stderr}\n${err ?? ""}`));
      resolve(JSON.parse(line.slice("PROBE ".length)));
    });
  });
}

test("the real preload exposes the bridge under preloadPrefs(), and not under the default sandbox", async () => {
  const sandboxed = await runProbe({});
  const unsandboxed = await runProbe({ sandbox: false });
  // The reason the helper exists. If Electron ever lets a sandboxed preload
  // require a package, this half turns red and the sandbox can come back.
  assert.match(sandboxed.preloadError ?? "", /module not found/);
  assert.equal(sandboxed.bridge, "undefined");
  // The fix.
  assert.equal(unsandboxed.preloadError, null);
  assert.equal(unsandboxed.bridge, "object");
});
