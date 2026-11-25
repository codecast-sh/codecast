// Run: node --test packages/electron/installedApps/host.test.js
//
// host.js against a recording platform host, a real registry over a temp
// settings.json, and a consent stand-in the test answers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAppsHost, engineFacts, appFromArgv } = require("./host");
const { createRegistry } = require("./registry");
const { HOST_METHODS } = require("./engine");
const { createSettingsFile } = require("../settingsFile");

const INFO = {
  slug: "k3j2h4ab",
  title: "Vitals",
  version: 7,
  app: { name: "Vitals", icon: null, window: { width: 420, height: 640 }, tray: { icon: null, width: 360, height: 480, tooltip: "Vitals" }, permissions: ["notifications", "full-access"] },
  icons: { 512: "https://a.codecast.sh/k3j2h4ab?icon=512", 1024: "https://a.codecast.sh/k3j2h4ab?icon=1024" },
  relation: "owner",
  policy: { install: true, fullAccess: true },
  gate: { k: "key1" },
};

function rig({ shellAlive = true, fetchImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-host-"));
  const file = path.join(dir, "settings.json");
  const settings = createSettingsFile(() => file);
  const registry = createRegistry({ settings, sealer: { seal: (s) => `S(${s})`, open: (s) => s.replace(/^S\((.*)\)$/, "$1") } });
  const calls = [];
  const open = new Set();
  const asks = [];
  const consent = {
    answers: [],
    ask(request, anchor) {
      asks.push({ request, anchor });
      return Promise.resolve(consent.answers.shift() ?? null);
    },
    get: (id) => ({ id }),
    answer: (id, a) => calls.push(["consent.answer", id, a]) && true,
    cancelAll: (slug) => calls.push(["cancelAll", slug]),
  };
  const handlers = new Map();
  const ipc = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) };
  const broadcasts = [];
  let deps = null;
  const host = createAppsHost({
    registry,
    consent,
    ipc,
    broadcast: (ch, data) => broadcasts.push([ch, data]),
    pageOrigin: "https://a.codecast.sh",
    appsDir: path.join(dir, "apps"),
    shell: { openExternal: async (u) => calls.push(["openExternal", u]), openPath: async (p) => (calls.push(["openPath", p]), "") },
    shellAlive: () => shellAlive,
    fetchImpl: fetchImpl || (async () => ({ ok: false, status: 404 })),
    log: () => {},
    createPlatform(d) {
      deps = d;
      const platform = {
        name: "test",
        emit: (slug, event, data) => calls.push(["emit", slug, event, data]),
        open: async (slug) => (open.add(slug), calls.push(["open", slug])),
        reload: (slug) => calls.push(["reload", slug]),
        isOpen: (slug) => open.has(slug),
        anchor: () => ({ x: 0, y: 0, width: 400, height: 600 }),
        install: async ({ record }) => (calls.push(["install", record.slug]), { shortcutPath: `/start/${record.name}.lnk` }),
        uninstall: async (record) => (open.delete(record.slug), calls.push(["uninstall", record.slug])),
        closeAll: () => calls.push(["closeAll"]),
      };
      for (const key of HOST_METHODS) if (key !== "agent.ask" && key !== "shell.open") platform[key] = (ctx, ...args) => (calls.push([key, ...args]), null);
      return platform;
    },
  });
  host.installIpc();
  host.start();
  const shell = (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args);
  return { host, registry, consent, asks, calls, open, deps: () => deps, shell, handlers, broadcasts, file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const flush = () => new Promise((r) => setImmediate(r));

test("appInfo's relation and policy become the engine's facts", () => {
  assert.deepEqual(engineFacts(INFO), { version: 7, relation: "own", policy: { install: true, fullAccess: true }, requested: ["notifications", "full-access"] });
  assert.equal(engineFacts({ ...INFO, relation: "anonymous" }).relation, "outside");
  assert.equal(engineFacts({ ...INFO, relation: "other" }).relation, "outside");
  assert.equal(engineFacts({ ...INFO, relation: "team" }).relation, "team");
});

test("install asks first, and records nothing when the sheet is closed", async () => {
  const r = rig();
  assert.deepEqual(await r.shell("apps:install", INFO), { installed: false });
  assert.equal(r.asks[0].request.kind, "install");
  assert.deepEqual(r.asks[0].request.asked, ["notifications", "full-access"]);
  assert.deepEqual(r.asks[0].request.added, ["notifications", "full-access"]);
  assert.equal(r.registry.get("k3j2h4ab"), null);
  assert.deepEqual(r.calls, []);
  r.done();
});

test("an approved install records the app, grants what was approved for this version, and opens it", async () => {
  const r = rig();
  r.consent.answers.push({ grants: ["notifications", "full-access"] });
  assert.deepEqual(await r.shell("apps:install", INFO), { installed: true, slug: "k3j2h4ab" });
  const record = r.registry.get("k3j2h4ab");
  assert.equal(record.name, "Vitals");
  assert.deepEqual(record.grants, ["notifications", "full-access"]);
  assert.equal(record.grantedVersion, 7);
  assert.equal(record.shortcutPath, "/start/Vitals.lnk");
  assert.deepEqual(r.registry.gateOf("k3j2h4ab"), { k: "key1" });
  assert.deepEqual(r.calls.map((c) => c[0]), ["install", "emit", "open"]);
  assert.deepEqual(r.calls[1], ["emit", "k3j2h4ab", "grants", { grants: ["notifications", "full-access"], version: 7 }]);
  // The page URL carries the gate keys the install stored.
  assert.equal(r.deps().pageUrl("k3j2h4ab", "tray"), "https://a.codecast.sh/k3j2h4ab?host=app&surface=tray&k=key1");
  await flush();
  const [channel, list] = r.broadcasts.at(-1);
  assert.equal(channel, "apps:changed");
  assert.deepEqual(list, [{ slug: "k3j2h4ab", name: "Vitals", iconUrl: INFO.icons[512], version: 7, grantedVersion: 7, grants: ["notifications", "full-access"], requested: ["notifications", "full-access"], needsReview: false, platform: process.platform }]);
  // Installing again just opens it.
  assert.deepEqual(await r.shell("apps:install", INFO), { installed: true, already: true });
  r.done();
});

test("full access is dropped from an install when the team does not allow it", async () => {
  const r = rig();
  r.consent.answers.push({ grants: ["notifications", "full-access"] });
  await r.shell("apps:install", { ...INFO, policy: { install: true, fullAccess: false } });
  assert.deepEqual(r.registry.get("k3j2h4ab").grants, ["notifications"]);
  await assert.rejects(r.shell("apps:install", { ...INFO, slug: "other123", policy: { install: false, fullAccess: false } }), /does not allow installing/);
  await assert.rejects(r.shell("apps:install", { error: "Locked" }), /Locked/);
  r.done();
});

async function installed(r, grants = ["notifications"]) {
  r.consent.answers.push({ grants });
  await r.shell("apps:install", INFO);
  r.calls.length = 0;
  r.asks.length = 0;
}

test("a republish reaches open surfaces as a version event and a reload, then re-asks once", async () => {
  const r = rig();
  await installed(r);
  r.handlers.get("apps:facts")({}, "k3j2h4ab", INFO); // a repeat changes nothing
  assert.deepEqual(r.calls, []);
  r.handlers.get("apps:facts")({}, "k3j2h4ab", { ...INFO, version: 8, app: { ...INFO.app, permissions: ["notifications", "menu-bar"] } });
  assert.deepEqual(r.calls.slice(0, 2), [["emit", "k3j2h4ab", "version", { version: 8 }], ["reload", "k3j2h4ab"]]);
  await flush();
  assert.equal(r.asks.length, 1);
  assert.equal(r.asks[0].request.kind, "review");
  assert.deepEqual(r.asks[0].request.current, ["notifications"]);
  assert.deepEqual(r.asks[0].request.added, ["menu-bar"]);
  assert.deepEqual(r.asks[0].anchor, { x: 0, y: 0, width: 400, height: 600 });
  const listed = await r.shell("apps:list");
  assert.equal(listed[0].needsReview, true);
  // The same version does not ask twice.
  r.handlers.get("apps:facts")({}, "k3j2h4ab", { ...INFO, version: 8, title: "Vitals 2" });
  await flush();
  assert.equal(r.asks.length, 1);
  // Facts for another slug, or not matching their slug, are ignored.
  r.handlers.get("apps:facts")({}, "k3j2h4ab", { ...INFO, slug: "zzzz1234", version: 9 });
  assert.equal(r.registry.get("k3j2h4ab").facts.version, 8);
  r.done();
});

test("an approved review grants for the new version", async () => {
  const r = rig();
  await installed(r);
  r.consent.answers.push({ grants: ["notifications"] });
  r.handlers.get("apps:facts")({}, "k3j2h4ab", { ...INFO, version: 8 });
  await flush();
  await flush();
  const record = r.registry.get("k3j2h4ab");
  assert.equal(record.grantedVersion, 8);
  assert.deepEqual(record.grants, ["notifications"]);
  r.done();
});

test("calls run through the engine against the stored grants and facts", async () => {
  const r = rig();
  await installed(r);
  const call = (module, method, args = [], version = 7) => r.deps().call("k3j2h4ab", { version, surface: "window" }, { id: 1, module, method, args });
  assert.deepEqual((await call("app", "notify", [{ title: "hi" }])).ok, true);
  assert.deepEqual(r.calls.at(-1), ["app.notify", { title: "hi" }]);
  assert.equal((await call("tray", "set", [{ title: "x" }])).code, "needs-consent");
  assert.equal((await call("app", "notify", [{ title: "hi" }], 6)).code, "mixed-version", "a frame still showing 6 while 7 is live reloads first");
  r.handlers.get("apps:facts")({}, "k3j2h4ab", { ...INFO, version: 8 });
  assert.equal((await call("app", "notify", [{ title: "hi" }], 7)).code, "mixed-version");
  assert.equal((await call("app", "notify", [{ title: "hi" }], 8)).code, "needs-consent");
  r.done();
});

test("setGrants writes the grants for the current version; shell.open runs in main", async () => {
  const r = rig();
  await installed(r, []);
  assert.deepEqual(await r.shell("apps:set-grants", "k3j2h4ab", ["full-access", "bogus"]), ["full-access"]);
  const reply = await r.deps().call("k3j2h4ab", { version: 7, surface: "window" }, { id: 2, module: "shell", method: "open", args: ["https://example.com"] });
  assert.equal(reply.ok, true, reply.message);
  assert.deepEqual(r.calls.at(-1), ["openExternal", "https://example.com"]);
  await r.deps().call("k3j2h4ab", { version: 7 }, { id: 3, module: "shell", method: "open", args: ["~/x.txt"] });
  assert.deepEqual(r.calls.at(-1), ["openPath", path.join(os.homedir(), "x.txt")]);
  const agent = await r.deps().call("k3j2h4ab", { version: 7 }, { id: 4, module: "agent", method: "ask", args: ["hi"] });
  assert.equal(agent.code, "needs-consent");
  r.done();
});

test("uninstall removes the platform install, the icons and the record", async () => {
  const r = rig();
  await installed(r);
  fs.mkdirSync(path.join(path.dirname(r.file), "apps", "k3j2h4ab"), { recursive: true });
  assert.equal(await r.shell("apps:uninstall", "k3j2h4ab"), true);
  assert.deepEqual(r.calls.map((c) => c[0]), ["cancelAll", "uninstall"]);
  assert.equal(r.registry.get("k3j2h4ab"), null);
  assert.equal(fs.existsSync(path.join(path.dirname(r.file), "apps", "k3j2h4ab")), false);
  assert.equal(await r.shell("apps:uninstall", "k3j2h4ab"), false);
  r.done();
});

test("--codecast-app=<slug> opens an installed app", async () => {
  const r = rig();
  await installed(r);
  r.open.clear();
  assert.equal(appFromArgv(["Codecast.exe", "--codecast-app=k3j2h4ab"]), "k3j2h4ab");
  assert.equal(appFromArgv(["--codecast-app=../x"]), null);
  assert.equal(r.host.handleArgv(["x", "--codecast-app=k3j2h4ab"]), true);
  await flush();
  assert.ok(r.open.has("k3j2h4ab"));
  assert.equal(r.host.handleArgv(["x", "codecast://open/inbox"]), false);
  r.done();
});

test("with no shell window, a focused app asks the server for its facts with its stored keys", async () => {
  const urls = [];
  const r = rig({
    shellAlive: false,
    fetchImpl: async (url) => (urls.push(url), { ok: true, json: async () => ({ ...INFO, version: 9, relation: "anonymous" }) }),
  });
  await installed(r);
  r.deps().onFocus("k3j2h4ab");
  await flush();
  await flush();
  assert.deepEqual(urls, ["https://a.codecast.sh/k3j2h4ab?app=1&k=key1"]);
  assert.equal(r.registry.get("k3j2h4ab").facts.version, 9);
  assert.equal(r.registry.get("k3j2h4ab").facts.relation, "anonymous");
  r.done();
});
