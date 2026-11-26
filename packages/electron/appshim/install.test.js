// Run: node --test packages/electron/appshim/install.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { install, uninstall, reseal, bundleName, bundlePath, dataPaths, readInfo, windowKeys } = require("./install");
const { writeSolidPng } = require("./fixtures");
const { clientSource } = require("../installedApps/protocol");

const mac = process.platform === "darwin";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "appshim-test-"));
const plistValue = (app, key) =>
  execFileSync("plutil", ["-extract", key, "raw", path.join(app, "Contents", "Info.plist")]).toString().trim();
// codesign -dv reports on stderr.
const sealInfo = (app) => spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr;

function fixture() {
  const dir = tmp();
  // Any universal Mach-O stands in for the shim: install never runs it.
  const shim = path.join(dir, "shim");
  fs.copyFileSync("/usr/bin/true", shim);
  return { dir, root: path.join(dir, "Codecast Apps"), shim, png: writeSolidPng(path.join(dir, "icon.png")) };
}

const opts = (f, over = {}) => ({
  slug: "vitals-x7", name: "Vitals", iconPngPath: f.png, shimBinaryPath: f.shim, root: f.root,
  pageUrl: "https://a.codecast.sh/vitals-x7", hostBundleId: "sh.codecast.desktop",
  socketPath: "/tmp/apps.sock", window: { width: 420, height: 640 }, register: false, ...over,
});

test("bundleName keeps the display name but strips path separators", () => {
  assert.equal(bundleName("Vitals"), "Vitals");
  assert.equal(bundleName("A/B: C"), "A-B- C");
  assert.equal(bundleName("..hidden"), "hidden");
  assert.throws(() => bundleName("  "));
});

test("install writes a sealed bundle the shim can read", { skip: !mac }, () => {
  const f = fixture();
  const r = install(opts(f));
  assert.equal(r.path, path.join(f.root, "Vitals.app"));
  assert.equal(r.bundleId, "sh.codecast.app.vitals-x7");
  assert.equal(plistValue(r.path, "CFBundleIdentifier"), "sh.codecast.app.vitals-x7");
  assert.equal(plistValue(r.path, "CFBundleExecutable"), "Vitals");
  assert.equal(plistValue(r.path, "CodecastAppSlug"), "vitals-x7");
  assert.equal(plistValue(r.path, "CodecastPageUrl"), "https://a.codecast.sh/vitals-x7");
  assert.equal(plistValue(r.path, "CodecastSocketPath"), "/tmp/apps.sock");
  assert.equal(plistValue(r.path, "CodecastWindowWidth"), "420");
  const icns = fs.readFileSync(path.join(r.path, "Contents", "Resources", "app.icns"));
  assert.equal(icns.subarray(0, 4).toString(), "icns");
  assert.equal(fs.readFileSync(path.join(r.path, "Contents", "Resources", "client.js"), "utf8"), clientSource());
  execFileSync("codesign", ["--verify", "--strict", "--deep", r.path]);
  const info = sealInfo(r.path);
  assert.match(info, /Signature=adhoc/);
  assert.match(info, /Identifier=sh\.codecast\.app\.vitals-x7/);
  // macOS may stamp com.apple.provenance (not strippable, not a Gatekeeper trigger); quarantine must be absent.
  assert.doesNotMatch(execFileSync("xattr", ["-r", r.path]).toString(), /com\.apple\.quarantine/);
  assert.deepEqual(fs.readdirSync(f.root), ["Vitals.app"], "no staging directory left behind");
});

test("a plist edit after sealing breaks the seal, so changes go through install or reseal", { skip: !mac }, () => {
  const f = fixture();
  const { path: app } = install(opts(f));
  fs.appendFileSync(path.join(app, "Contents", "Info.plist"), "\n");
  assert.throws(() => execFileSync("codesign", ["--verify", "--strict", app], { stdio: "pipe" }));
  reseal({ appPath: app, shimBinaryPath: f.shim, register: false });
  execFileSync("codesign", ["--verify", "--strict", app]);
});

test("the manifest's window options become typed Info.plist keys; ones it leaves out are left out", () => {
  assert.deepEqual(windowKeys({ width: 420.4, height: 640, minWidth: 320, minHeight: 400, resizable: false, titleBar: "hidden" }), {
    CodecastWindowWidth: 420, CodecastWindowHeight: 640, CodecastMinWidth: 320, CodecastMinHeight: 400,
    CodecastResizable: false, CodecastTitleBar: "hidden",
  });
  assert.deepEqual(Object.values(windowKeys({ width: -1, titleBar: "glass", resizable: "yes" })).filter((v) => v !== undefined), []);
});

test("install and reseal write the window keys with their types; reseal removes one set to null", { skip: !mac }, () => {
  const f = fixture();
  const { path: app } = install(opts(f, { window: { width: 420, height: 640, minWidth: 320, minHeight: 400, resizable: false, titleBar: "hidden" } }));
  let info = readInfo(app);
  assert.equal(info.CodecastMinWidth, 320);
  assert.equal(info.CodecastMinHeight, 400);
  assert.equal(info.CodecastResizable, false);
  assert.equal(info.CodecastTitleBar, "hidden");
  reseal({ appPath: app, shimBinaryPath: f.shim, register: false, plist: { CodecastResizable: true, CodecastMinWidth: 500, CodecastTitleBar: null } });
  info = readInfo(app);
  assert.equal(info.CodecastResizable, true);
  assert.equal(info.CodecastMinWidth, 500);
  assert.equal("CodecastTitleBar" in info, false);
  execFileSync("codesign", ["--verify", "--strict", app]);
});

test("reinstall replaces the bundle; uninstall removes it", { skip: !mac }, () => {
  const f = fixture();
  install(opts(f));
  const { path: app } = install(opts(f, { pageUrl: "https://a.codecast.sh/vitals-x7?v=2" }));
  assert.equal(plistValue(app, "CodecastPageUrl"), "https://a.codecast.sh/vitals-x7?v=2");
  assert.equal(uninstall({ name: "Vitals", root: f.root, register: false }), true);
  assert.equal(fs.existsSync(bundlePath("Vitals", f.root)), false);
  assert.equal(uninstall({ name: "Vitals", root: f.root, register: false }), false);
});

test("a failed install leaves nothing behind", { skip: !mac }, () => {
  const f = fixture();
  assert.throws(() => install(opts(f, { iconPngPath: path.join(f.dir, "missing.png") })));
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.throws(() => install(opts(f, { slug: "bad slug" })), /bad slug/);
});

test("uninstall with the slug also removes the app's storage kept per bundle id", { skip: !mac }, () => {
  const f = fixture();
  const home = path.join(f.dir, "home");
  install(opts(f));
  const paths = dataPaths("vitals-x7", home);
  assert.ok(paths.some((p) => p.endsWith(path.join("Library", "WebKit", "sh.codecast.app.vitals-x7"))));
  for (const p of paths) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); }
  const other = path.join(home, "Library", "WebKit", "sh.codecast.app.other");
  fs.writeFileSync(other, "keep");
  assert.equal(uninstall({ name: "Vitals", slug: "vitals-x7", root: f.root, register: false, home }), true);
  for (const p of paths) assert.equal(fs.existsSync(p), false, p);
  assert.equal(fs.existsSync(other), true);
});
