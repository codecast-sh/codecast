// Run: node --test packages/electron/installedApps/engine.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");
const { createEngine, settingsRegistry, acceleratorProblem, ARGS, HOST_METHODS, TIERS } = require("./engine");
const { AppError } = require("./protocol");
const { createSettingsFile } = require("../settingsFile");

// A host that records every call, a registry in memory, and page facts the
// test can move.
function rig({ record = {}, facts = {}, consent = () => null } = {}) {
  const records = { vitals: { slug: "vitals", name: "Vitals", grantedVersion: 3, grants: [], ...record } };
  const page = { version: 3, relation: "own", policy: { install: true, fullAccess: true }, requested: ["notifications"], ...facts };
  const calls = [];
  const events = [];
  const adapter = { consent: (req) => (calls.push(["consent", req]), consent(req)), emit: (slug, event, data) => events.push([slug, event, data]) };
  for (const key of HOST_METHODS) adapter[key] = (ctx, ...args) => (calls.push([key, ...args]), { done: key, slug: ctx.slug });
  const registry = {
    get: (slug) => records[slug] || null,
    update: (slug, patch) => Object.assign(records[slug], patch),
  };
  const engine = createEngine({ registry, page: async () => page, adapter, platform: "darwin" });
  const call = (module, method, args = [], frame = { version: page.version, surface: "window" }) =>
    engine.handle("vitals", frame, { id: 7, module, method, args });
  return { engine, call, calls, events, records, page, adapter };
}

const refused = (reply, code) => {
  assert.equal(reply.ok, false, `expected ${code}, got ${JSON.stringify(reply)}`);
  assert.equal(reply.code, code, reply.message);
  assert.equal(reply.id, 7);
};

test("the schema table and the tier table name the same methods", () => {
  assert.deepEqual(Object.keys(ARGS).sort(), Object.keys(TIERS.methods).sort());
  for (const tier of Object.values(TIERS.methods)) assert.ok(tier === "default" || TIERS.permissions.includes(tier), tier);
});

test("the engine's permissions are the install sheet's (shared/contracts/pageApp.ts), in the same order", () => {
  // The packaged desktop app runs plain JS and cannot import the TS contract,
  // so tiers.json carries the list too; this keeps the two equal.
  const contract = require("node:fs").readFileSync(join(__dirname, "../../shared/contracts/pageApp.ts"), "utf8");
  const literal = contract.match(/export const APP_PERMISSIONS = (\[[^\]]*\]) as const;/);
  assert.ok(literal, "APP_PERMISSIONS literal not found in pageApp.ts");
  assert.deepEqual(JSON.parse(literal[1]), TIERS.permissions);
});

test("an adapter missing a host method is refused at startup", () => {
  assert.throws(
    () => createEngine({ registry: {}, page: () => null, adapter: { consent() {}, emit() {} } }),
    /adapter is missing: .*app\.notify/,
  );
});

test("unknown methods, including prototype names, are unknown-method", async () => {
  const { call } = rig();
  refused(await call("fs", "chmod"), "unknown-method");
  refused(await call("constructor", "prototype"), "unknown-method");
  refused(await call("app", "hasOwnProperty"), "unknown-method");
  refused(await call(undefined, "info"), "unknown-method");
});

test("a slug with no record is not-installed", async () => {
  const { engine } = rig();
  refused(await engine.handle("other", { version: 3 }, { id: 7, module: "app", method: "info", args: [] }), "not-installed");
});

test("a team that turned installs off refuses every call", async () => {
  const { call } = rig({ facts: { policy: { install: false, fullAccess: false } } });
  refused(await call("app", "info"), "not-allowed-by-team");
});

test("args are checked per method", async () => {
  const { call, calls } = rig({ record: { grants: ["notifications", "full-access", "shortcuts"] } });
  refused(await call("app", "badge", [-1]), "bad-args");
  refused(await call("app", "badge", [1.5]), "bad-args");
  refused(await call("app", "badge", [1, 2]), "bad-args");
  refused(await call("window", "setSize", [0, 100]), "bad-args");
  refused(await call("app", "notify", [{ body: "no title" }]), "bad-args");
  refused(await call("app", "notify", [{ title: "t", onclick: "x" }]), "bad-args");
  refused(await call("app", "notify", ["t"]), "bad-args");
  for (const k of ["constructor", "toString", "hasOwnProperty"]) {
    refused(await call("app", "notify", [{ title: "t", [k]: "x" }]), "bad-args");
  }
  refused(await call("app", "notify", [JSON.parse('{"title":"t","__proto__":{"x":1}}')]), "bad-args");
  refused(await call("fs", "readText", ["relative/path"]), "bad-args");
  refused(await call("process", "run", ["ls", "-la"]), "bad-args");
  refused(await call("process", "run", ["ls", [], { env: { A: 1 } }]), "bad-args");
  refused(await call("permissions", "request", [["camera"]]), "bad-args");
  refused(await call("permissions", "request", [[]]), "bad-args");
  refused(await call("app", "info", "not an array"), "bad-args");
  assert.equal(calls.length, 0);
  // Trailing absent args are fine; a missing optional object is fine.
  assert.equal((await call("tray", "set", [], { version: 3 })).code, "needs-consent");
  assert.equal((await call("app", "notify", [{ title: "t", tag: undefined }, null])).ok, true);
});

test("a global shortcut needs at least two distinct modifiers and one key", async () => {
  for (const ok of ["CmdOrCtrl+Shift+K", "Alt+Shift+F12", "Control+Option+Space", "Cmd+Shift+Plus", "Ctrl+Alt++"]) {
    assert.equal(acceleratorProblem(ok), null, ok);
  }
  const bad = {
    "CmdOrCtrl+K": /two modifiers/,
    K: /two modifiers/,
    "Shift+Shift+K": /repeats/,
    "CmdOrCtrl+Cmd+K": /repeats/,
    "Hyper+Shift+K": /unknown modifier/,
    "Cmd+Shift": /one key/,
    "Cmd+Shift+KK": /one key/,
  };
  for (const [accel, why] of Object.entries(bad)) assert.match(acceleratorProblem(accel), why, accel);
  const { call } = rig({ record: { grants: ["shortcuts"] } });
  const reply = await call("shortcuts", "register", ["CmdOrCtrl+K"]);
  refused(reply, "bad-args");
  assert.match(reply.message, /two modifiers/);
  assert.equal((await call("shortcuts", "register", ["CmdOrCtrl+Shift+K"])).ok, true);
});

test("default calls run with no grants, even from a window a version behind", async () => {
  const { call, calls } = rig({ facts: { version: 4 } });
  const reply = await call("window", "setTitle", ["Hello"], { version: 3 });
  assert.deepEqual(reply, { id: 7, ok: true, value: { done: "window.setTitle", slug: "vitals" } });
  assert.deepEqual(calls, [["window.setTitle", "Hello"]]);
});

test("a non-default call from an older window is mixed-version, before any grant check", async () => {
  const { call, calls } = rig({ record: { grantedVersion: 4, grants: ["notifications"] }, facts: { version: 4 } });
  refused(await call("app", "notify", [{ title: "t" }], { version: 3 }), "mixed-version");
  refused(await call("permissions", "request", [["notifications"]], { version: 3 }), "mixed-version");
  assert.equal(calls.length, 0);
  assert.equal((await call("app", "notify", [{ title: "t" }], { version: 4 })).ok, true);
});

test("an app permission not granted is needs-consent", async () => {
  const { call, calls } = rig({ record: { grants: ["shortcuts"] } });
  const reply = await call("app", "notify", [{ title: "t" }]);
  refused(reply, "needs-consent");
  assert.match(reply.message, /"notifications" permission/);
  assert.equal(calls.length, 0);
});

test("grants given for an older version stop working when the page moves on", async () => {
  const { call, page } = rig({ record: { grantedVersion: 3, grants: ["notifications"] } });
  assert.equal((await call("app", "notify", [{ title: "t" }])).ok, true);
  page.version = 4;
  const reply = await call("app", "notify", [{ title: "t" }]);
  refused(reply, "needs-consent");
  assert.match(reply.message, /version 4 needs your approval again/);
  assert.deepEqual((await call("app", "info")).value.grants, []);
});

test("a window newer than the host's last look at the page counts as the current version", async () => {
  const { call } = rig({ record: { grantedVersion: 3, grants: ["notifications"] }, facts: { version: 3 } });
  refused(await call("app", "notify", [{ title: "t" }], { version: 4 }), "needs-consent");
});

test("full access is refused for outside pages and when the team policy is off", async () => {
  const grants = { grantedVersion: 3, grants: ["full-access"] };
  refused(await rig({ record: grants, facts: { relation: "outside" } }).call("fs", "list", ["/tmp"]), "not-your-page");
  refused(
    await rig({ record: grants, facts: { relation: "team", policy: { install: true, fullAccess: false } } }).call("fs", "list", ["/tmp"]),
    "not-allowed-by-team",
  );
  refused(await rig({ record: grants, facts: { policy: { install: true } } }).call("shell", "open", ["https://x.y"]), "not-allowed-by-team");
  refused(await rig({ facts: { relation: "team" } }).call("fs", "list", ["/tmp"]), "needs-consent");
  const team = rig({ record: grants, facts: { relation: "team" } });
  assert.equal((await team.call("shell", "open", ["https://x.y"])).ok, true);
});

test("full access runs files and programs in the engine's own ops", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "cast-app-engine-"));
  try {
    writeFileSync(join(dir, "a.txt"), "hello");
    const { call, calls } = rig({ record: { grants: ["full-access"] } });
    assert.equal((await call("fs", "readText", [join(dir, "a.txt")])).value, "hello");
    assert.equal((await call("fs", "writeText", [join(dir, "b.txt"), "there"])).ok, true);
    assert.deepEqual((await call("fs", "list", [dir])).value.map((e) => e.name).sort(), ["a.txt", "b.txt"]);
    const run = await call("process", "run", [process.execPath, ["-e", "process.stdout.write('ran')"]]);
    assert.equal(run.value.stdout, "ran");
    assert.equal(run.value.code, 0);
    const missing = await call("fs", "readText", [join(dir, "none.txt")]);
    refused(missing, "failed");
    assert.match(missing.message, /ENOENT/);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fs.watch pushes fs-change through the adapter and release closes it", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "cast-app-watch-"));
  try {
    const { call, events, engine } = rig({ record: { grants: ["full-access"] } });
    const watchId = (await call("fs", "watch", [dir])).value;
    assert.match(watchId, /^w\d+$/);
    writeFileSync(join(dir, "c.txt"), "x");
    for (let i = 0; i < 50 && !events.some((e) => e[1] === "fs-change"); i++) await new Promise((r) => setTimeout(r, 20));
    const change = events.find((e) => e[1] === "fs-change");
    assert.ok(change, "no fs-change event");
    assert.equal(change[0], "vitals");
    assert.equal(change[2].watchId, watchId);
    assert.equal((await call("fs", "unwatch", [watchId])).value, true);
    assert.equal((await call("fs", "unwatch", [watchId])).value, false);
    await call("fs", "watch", [dir]);
    engine.release("vitals");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permissions.request returns current grants without asking when nothing is new", async () => {
  const { call, calls } = rig({ record: { grants: ["notifications", "shortcuts"] } });
  assert.deepEqual((await call("permissions", "request", [["notifications"]])).value, ["notifications", "shortcuts"]);
  assert.equal(calls.length, 0);
});

test("permissions.request asks through the consent sheet and stores grants for this version", async () => {
  const { call, calls, records, events, page } = rig({
    record: { grantedVersion: 2, grants: ["notifications"] },
    consent: (req) => [...req.requested, "bogus"],
  });
  const reply = await call("permissions", "request", [["notifications", "menu-bar"]]);
  assert.deepEqual(reply.value, ["notifications", "menu-bar"]);
  const [, req] = calls.find((c) => c[0] === "consent");
  assert.deepEqual(req, { slug: "vitals", name: "Vitals", version: page.version, requested: ["notifications", "menu-bar"], granted: [], fullAccessOffered: true });
  assert.deepEqual(records.vitals.grants, ["notifications", "menu-bar"]);
  assert.equal(records.vitals.grantedVersion, 3);
  assert.deepEqual(events, [["vitals", "grants", { grants: ["notifications", "menu-bar"], version: 3 }]]);
  assert.equal((await call("tray", "set", [{ title: "3" }])).ok, true);
});

test("permissions.request is denied when the person says no, and nothing is stored", async () => {
  const { call, records } = rig({ consent: () => null });
  refused(await call("permissions", "request", [["agent"]]), "denied");
  assert.deepEqual(records.vitals.grants, []);
});

test("permissions.request for full access follows the page relation and team policy", async () => {
  refused(await rig({ facts: { relation: "outside" } }).call("permissions", "request", [["full-access"]]), "not-your-page");
  refused(await rig({ facts: { policy: { install: true, fullAccess: false } } }).call("permissions", "request", [["full-access"]]), "not-allowed-by-team");
  // A sheet that hands back full access where it is not allowed does not store it.
  const r = rig({ facts: { policy: { install: true, fullAccess: false } }, consent: () => ["notifications", "full-access"] });
  assert.deepEqual((await r.call("permissions", "request", [["notifications"]])).value, ["notifications"]);
  assert.equal(r.calls.find((c) => c[0] === "consent")[1].fullAccessOffered, false);
});

test("info reports the frame, platform, live grants and the manifest's asks", async () => {
  const { call } = rig({ record: { grants: ["notifications"] } });
  const reply = await call("app", "info", [], { version: 3, surface: "tray" });
  assert.deepEqual(reply.value, {
    slug: "vitals",
    name: "Vitals",
    version: 3,
    surface: "tray",
    platform: "darwin",
    grants: ["notifications"],
    requested: ["notifications"],
  });
});

test("an adapter's own refusal keeps its code; anything else it throws is failed", async () => {
  const { call, adapter } = rig({ record: { grants: ["agent"] } });
  adapter["agent.ask"] = () => {
    throw new AppError("denied", "agent is off");
  };
  refused(await call("agent", "ask", ["hi"]), "denied");
  adapter["agent.ask"] = async () => {
    throw new Error("usage limit");
  };
  const reply = await call("agent", "ask", ["hi"]);
  refused(reply, "failed");
  assert.equal(reply.message, "usage limit");
});

test("settingsRegistry reads and writes installedApps in settings.json", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "cast-app-registry-"));
  try {
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ theme: "dark", installedApps: { vitals: { slug: "vitals", grants: [] } } }));
    const registry = settingsRegistry(createSettingsFile(() => file));
    assert.equal(registry.get("none"), null);
    registry.update("vitals", { grants: ["agent"], grantedVersion: 5 });
    const fresh = settingsRegistry(createSettingsFile(() => file));
    assert.deepEqual(fresh.get("vitals"), { slug: "vitals", grants: ["agent"], grantedVersion: 5 });
    assert.throws(() => fresh.update("none", {}), (e) => e.code === "not-installed");
    assert.equal(createSettingsFile(() => file).load().theme, "dark");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
