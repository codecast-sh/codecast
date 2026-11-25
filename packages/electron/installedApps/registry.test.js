// Run: node --test packages/electron/installedApps/registry.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRegistry, safeStorageSealer, isSlug } = require("./registry");
const { createSettingsFile } = require("../settingsFile");

// safeStorage's shape, with a reversible "cipher" so the test can see sealing happened.
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc(${s})`),
  decryptString: (b) => b.toString().replace(/^enc\((.*)\)$/, "$1"),
});

function rig({ available = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-registry-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ shortcuts: { a: "b" } }));
  const settings = createSettingsFile(() => file);
  const registry = createRegistry({ settings, sealer: safeStorageSealer(fakeSafeStorage(available)), now: () => 1000 });
  return { registry, file, read: () => JSON.parse(fs.readFileSync(file, "utf8")), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const INFO = { slug: "k3j2h4ab", title: "Vitals", version: 7, app: { name: "Vitals", permissions: ["notifications"] }, relation: "owner", policy: { install: true, fullAccess: false }, gate: { k: "secret" } };

test("an install lands in settings.json beside the other settings, with its gate sealed", () => {
  const r = rig();
  r.registry.add({ slug: "k3j2h4ab", name: "Vitals", gate: { k: "secret", m: "team", x: "ignored" }, facts: INFO });
  const disk = r.read();
  assert.deepEqual(disk.shortcuts, { a: "b" });
  const rec = disk.installedApps.k3j2h4ab;
  assert.equal(rec.name, "Vitals");
  assert.equal(rec.installedAt, 1000);
  assert.deepEqual(rec.grants, []);
  assert.equal(rec.grantedVersion, 0);
  assert.ok(rec.gate.k.startsWith("sealed:"), rec.gate.k);
  assert.ok(!JSON.stringify(rec).includes("secret"), "no plain gate secret on disk");
  assert.equal(rec.gate.x, undefined);
  assert.equal(rec.facts.gate, undefined, "facts keep no gate keys");
  assert.deepEqual(r.registry.gateOf("k3j2h4ab"), { k: "secret", m: "team" });
  r.done();
});

test("without an OS keystore the gate is stored plain and still opens", () => {
  const r = rig({ available: false });
  r.registry.add({ slug: "k3j2h4ab", name: "Vitals", gate: { k: "secret" } });
  assert.equal(r.read().installedApps.k3j2h4ab.gate.k, "secret");
  assert.deepEqual(r.registry.gateOf("k3j2h4ab"), { k: "secret" });
  r.done();
});

test("updates merge over what is on disk now, never over a stale copy", () => {
  const r = rig();
  r.registry.add({ slug: "k3j2h4ab", name: "Vitals", gate: {} });
  // Another writer (Settings in the shell) changes the file between our reads.
  const disk = r.read();
  disk.installedApps.k3j2h4ab.bounds = { x: 1, y: 2, width: 300, height: 400 };
  disk.zoom = 2;
  const later = Date.now() / 1000 + 5;
  fs.writeFileSync(r.file, JSON.stringify(disk));
  fs.utimesSync(r.file, later, later);
  r.registry.update("k3j2h4ab", { grants: ["notifications"], grantedVersion: 7 });
  const rec = r.read().installedApps.k3j2h4ab;
  assert.deepEqual(rec.bounds, { x: 1, y: 2, width: 300, height: 400 });
  assert.deepEqual(rec.grants, ["notifications"]);
  assert.equal(r.read().zoom, 2);
  assert.throws(() => r.registry.update("nope123", {}), (e) => e.code === "not-installed");
  r.done();
});

test("facts are stored once per change and report the version they replace", () => {
  const r = rig();
  const changes = [];
  r.registry.onChange((slug) => changes.push(slug));
  r.registry.add({ slug: "k3j2h4ab", name: "Vitals", gate: {}, facts: INFO });
  assert.deepEqual(r.registry.setFacts("k3j2h4ab", INFO), { changed: false, prevVersion: 7 });
  assert.deepEqual(r.registry.setFacts("k3j2h4ab", { ...INFO, version: 8 }), { changed: true, prevVersion: 7 });
  assert.equal(r.registry.get("k3j2h4ab").facts.version, 8);
  assert.deepEqual(r.registry.setFacts("missing1", INFO), { changed: false, prevVersion: null });
  assert.deepEqual(changes, ["k3j2h4ab", "k3j2h4ab"]);
  assert.equal(r.registry.remove("k3j2h4ab"), true);
  assert.equal(r.registry.get("k3j2h4ab"), null);
  assert.deepEqual(r.read().installedApps, {});
  assert.deepEqual(changes, ["k3j2h4ab", "k3j2h4ab", "k3j2h4ab"]);
  r.done();
});

test("only page slugs become installs (they name partitions, bundle ids and AUMIDs)", () => {
  for (const ok of ["k3j2h4ab", "abc", "A1-b2"]) assert.ok(isSlug(ok), ok);
  for (const bad of ["", "ab", "../etc", "a b", "a/b", "a.b", "-abc", null, 42]) assert.ok(!isSlug(bad), String(bad));
  const r = rig();
  assert.throws(() => r.registry.add({ slug: "../x", name: "x" }), /not a page slug/);
  r.done();
});
