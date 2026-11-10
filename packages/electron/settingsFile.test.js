// Run: node --test packages/electron/settingsFile.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSettingsFile } = require("./settingsFile");

function rig(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-settings-"));
  const file = path.join(dir, "settings.json");
  if (initial !== undefined) fs.writeFileSync(file, typeof initial === "string" ? initial : JSON.stringify(initial));
  const counts = { read: 0, write: 0, rename: 0 };
  const io = {
    ...fs,
    readFileSync: (...a) => { counts.read++; return fs.readFileSync(...a); },
    writeFileSync: (...a) => { counts.write++; return fs.writeFileSync(...a); },
    renameSync: (...a) => { counts.rename++; return fs.renameSync(...a); },
  };
  return { dir, file, counts, io, settings: createSettingsFile(() => file, io), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a missing, empty, malformed or non-object file reads as {}", () => {
  for (const initial of [undefined, "", "{ half", "null", "[1]", "7"]) {
    const r = rig(initial);
    assert.deepEqual(r.settings.load(), {});
    r.done();
  }
});

test("repeated reads parse the file once", () => {
  const r = rig({ env: "local", shortcuts: { newSession: "" } });
  for (let i = 0; i < 50; i++) assert.equal(r.settings.load().env, "local");
  assert.equal(r.counts.read, 1);
  r.done();
});

test("an update merges at the top level, lands on disk, and the next read costs no parse", () => {
  const r = rig({ env: "local", agentDock: { enabled: true } });
  r.settings.update({ warnBeforeQuit: false, agentDock: { enabled: false } });
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, "utf8")), { env: "local", agentDock: { enabled: false }, warnBeforeQuit: false });
  const reads = r.counts.read;
  assert.deepEqual(r.settings.load(), { env: "local", agentDock: { enabled: false }, warnBeforeQuit: false });
  assert.equal(r.counts.read, reads);
  r.done();
});

test("what memory holds after an update is what the file holds", () => {
  const r = rig({});
  r.settings.update({ dropped: undefined, kept: { at: new Date(0) } });
  assert.deepEqual(r.settings.load(), JSON.parse(fs.readFileSync(r.file, "utf8")));
  assert.equal("dropped" in r.settings.load(), false);
  r.done();
});

test("an edit made by hand while the app runs is read, and survives the next update", () => {
  const r = rig({ a: 1 });
  assert.deepEqual(r.settings.load(), { a: 1 });
  fs.writeFileSync(r.file, JSON.stringify({ a: 1, agentDock: { enabled: true } }));
  assert.deepEqual(r.settings.load().agentDock, { enabled: true });
  r.settings.update({ b: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, "utf8")), { a: 1, agentDock: { enabled: true }, b: 2 });
  r.done();
});

test("the file is replaced by rename, and a write that fails leaves the old one whole", () => {
  const r = rig({ a: 1 });
  r.settings.update({ b: 2 });
  assert.equal(r.counts.rename, 1);
  assert.deepEqual(fs.readdirSync(r.dir), ["settings.json"]);

  const broken = createSettingsFile(() => r.file, { ...fs, renameSync: () => { throw new Error("ENOSPC"); } });
  assert.throws(() => broken.update({ c: 3 }), /ENOSPC/);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, "utf8")), { a: 1, b: 2 });
  assert.deepEqual(fs.readdirSync(r.dir), ["settings.json"], "no temp file left behind");
  assert.deepEqual(broken.load(), { a: 1, b: 2 });
  r.done();
});
