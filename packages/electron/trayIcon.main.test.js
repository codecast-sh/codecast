const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { trayIconState } = require("./trayIcon");

function loadTray() {
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const traySource = source.slice(source.indexOf('const { trayIconState }'), source.indexOf("function buildAppMenu()"));
  const badgeSource = source.slice(source.indexOf('ipcMain.handle("set-badge-count"'), source.indexOf('ipcMain.handle("get-env"'));
  const handlers = new Map();
  const badges = [];
  const images = [];
  const trays = [];
  const context = vm.createContext({
    require, path, __dirname,
    tray: null,
    app: { getVersion: () => "test", setBadgeCount: n => badges.push(n) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Menu: { buildFromTemplate: items => items },
    nativeImage: { createFromPath: file => ({ file, setTemplateImage(value) { this.template = value; } }) },
    Tray: class {
      constructor(image) { this.image = image; this.destroyed = false; trays.push(this); }
      isDestroyed() { return this.destroyed; }
      setImage(image) { this.image = image; images.push(image); }
      setToolTip(text) { this.tooltip = text; }
      setContextMenu() {}
    },
  });
  vm.runInContext(traySource + "\n" + badgeSource, context);
  return { badges, images, trays, create: () => vm.runInContext("createTray()", context), report: n => handlers.get("set-badge-count")(null, n) };
}

test("badge reports update both native attention surfaces without redundant images", () => {
  const rig = loadTray();
  rig.create();
  const tray = rig.trays[0];
  rig.report(3);
  assert.deepEqual(rig.badges, [3]);
  assert.equal(path.basename(tray.image.file), trayIconState(3).file);
  assert.equal(tray.image.template, trayIconState(3).template);
  assert.equal(tray.tooltip, "Codecast · 3 sessions need input");
  rig.report(4);
  assert.equal(rig.images.length, 1);
  assert.equal(tray.tooltip, "Codecast · 4 sessions need input");
  rig.report(0);
  assert.equal(rig.images.length, 2);
  assert.equal(path.basename(tray.image.file), trayIconState(0).file);
  assert.equal(tray.tooltip, "Codecast");
  tray.destroyed = true;
  rig.report(2);
  assert.equal(rig.images.length, 2);
});

test("a badge report before tray creation survives until the tray exists", () => {
  const rig = loadTray();
  rig.report(2);
  rig.create();
  assert.equal(path.basename(rig.trays[0].image.file), trayIconState(2).file);
  assert.equal(rig.trays[0].tooltip, "Codecast · 2 sessions need input");
});
