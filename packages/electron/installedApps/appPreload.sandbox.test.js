// Run: node --test packages/electron/installedApps/appPreload.sandbox.test.js
//
// The app preload in a real Electron renderer under the exact webPreferences
// an installed app's window gets (sandbox: true). A sandboxed preload can
// require only electron's own modules, which is why the client travels in the
// command line; this proves that path end to end: the client is defined
// before the page's first script, sits beside castData's window.cast, answers
// calls through ipcMain, receives host events, and ignores the page's CSP.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const CAST_DATA_TS = readFileSync(join(__dirname, "../../convex/convex/lib/castData.ts"), "utf8");
const CAST_DATA = CAST_DATA_TS.match(/const CAST_DATA = String\.raw`([\s\S]*?)`;/)[1];

const PROBE = `
const { app, BrowserWindow, ipcMain } = require("electron");
const { appWebPreferences } = require(${JSON.stringify(join(__dirname, "protocol.js"))});
const page = process.argv[process.argv.length - 1];
app.whenReady().then(async () => {
  const calls = [];
  ipcMain.handle("cast-app:call", (_e, msg) => {
    calls.push(msg);
    if (msg.method === "info") return { id: msg.id, ok: true, value: { slug: "probe" } };
    return { id: msg.id, ok: false, code: "needs-consent", message: "ask first" };
  });
  const win = new BrowserWindow({ show: false, webPreferences: appWebPreferences("probe") });
  let preloadError = null;
  win.webContents.on("preload-error", (_e, _p, err) => { preloadError = err.message; });
  await win.loadFile(page);
  win.webContents.send("cast-app:event", { event: "shortcut", data: { accelerator: "CmdOrCtrl+Shift+K" } });
  await new Promise((r) => setTimeout(r, 200));
  const report = await win.webContents.executeJavaScript(\`(async () => ({
    atParse: window.__atParse === undefined ? "no page script ran" : window.__atParse,
    app: typeof (window.cast && window.cast.app && window.cast.app.info),
    data: typeof (window.cast && window.cast.data),
    state: typeof (window.cast && window.cast.state),
    info: await window.cast.app.info(),
    refusal: await window.cast.app.notify({ title: "t" }).then(() => null, (e) => ({ code: e.code, message: e.message, isError: e instanceof Error })),
    events: window.__events || null,
    requireInPage: typeof require,
  }))()\`);
  win.destroy();
  process.stdout.write("PROBE " + JSON.stringify({ preloadError, calls, ...report }) + "\\n");
  app.exit(0);
}).catch((e) => { process.stdout.write("PROBE " + JSON.stringify({ error: String(e && e.stack || e) }) + "\\n"); app.exit(1); });
`;

function runProbe(html) {
  const dir = mkdtempSync(join(os.tmpdir(), "cast-app-preload-"));
  const probe = join(dir, "probe.js");
  const page = join(dir, "page.html");
  writeFileSync(probe, PROBE);
  writeFileSync(page, html);
  const electron = require("electron");
  return new Promise((resolve, reject) => {
    execFile(electron, [probe, `--user-data-dir=${join(dir, "profile")}`, page], { timeout: 60_000, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      const line = String(stdout).split("\n").find((l) => l.startsWith("PROBE "));
      if (!line) return reject(new Error(`no probe report\n${stderr}\n${err ?? ""}`));
      resolve(JSON.parse(line.slice("PROBE ".length)));
    });
  });
}

test("sandboxed: cast.app exists before the page's first script and merges with castData's window.cast", async () => {
  const html = `<!doctype html><html><head>
<script>window.__atParse = typeof (window.cast && window.cast.app && window.cast.app.info);</script>
<script data-endpoint="https://example.invalid/data">${CAST_DATA}</script>
<script>window.__events = []; window.cast.app.on("shortcut", function (d) { window.__events.push(d.accelerator); });</script>
</head><body>probe</body></html>`;
  const out = await runProbe(html);
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.preloadError, null);
  assert.equal(out.atParse, "function");
  assert.equal(out.app, "function");
  assert.equal(out.data, "function");
  assert.equal(out.state, "function");
  assert.deepEqual(out.info, { slug: "probe" });
  assert.deepEqual(out.refusal, { code: "needs-consent", message: "ask first", isError: true });
  assert.deepEqual(out.events, ["CmdOrCtrl+Shift+K"]);
  assert.equal(out.requireInPage, "undefined");
  assert.deepEqual(
    out.calls.map((c) => [c.module, c.method, c.args]),
    [
      ["app", "info", []],
      ["app", "notify", [{ title: "t" }]],
    ],
  );
});

test("sandboxed: a page whose CSP forbids every script still gets cast.app", async () => {
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head><body>locked</body></html>`;
  const out = await runProbe(html);
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.preloadError, null);
  assert.equal(out.atParse, "no page script ran");
  assert.equal(out.app, "function");
  assert.deepEqual(out.info, { slug: "probe" });
});
