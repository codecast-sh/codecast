// Run: node --test packages/electron/installedApps/macHost.test.js
// The macOS host against fake shims: plain socket clients speaking the shim's
// wire to the real engine through the host. Bundle tests build real bundles
// (sips, iconutil, codesign) in a temp root, unregistered.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createMacHost, pageUrlFor } = require("./macHost");
const { createEngine, HOST_METHODS, MAIN_METHODS } = require("./engine");
const { readInfo, dataPaths } = require("../appshim/install");
const { writeSolidPng } = require("../appshim/fixtures");

const mac = process.platform === "darwin";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "machost-"));

/** A socket client that speaks the shim's wire. */
function fakeShim(socketPath, app) {
  const socket = net.createConnection(socketPath);
  const events = [];
  const waiting = new Map();
  const eventWaiters = [];
  let nextId = 1;
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (line.event) {
        events.push(line);
        eventWaiters.splice(0).forEach((w) => w());
      } else waiting.get(line.id)?.(line);
    }
  });
  const send = (envelope) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    socket.write(`${JSON.stringify({ ...envelope, msg: { ...envelope.msg, id } })}\n`);
  });
  return {
    ready: new Promise((r) => socket.once("connect", r)),
    events,
    call: (module, method, args = [], frame = { version: 3, surface: "window" }) => send({ app, frame, msg: { module, method, args } }),
    host: (action, data = {}) => send({ app, host: action, data, msg: {} }),
    raw: send,
    async nextEvent(name) {
      for (;;) {
        const found = events.find((e) => e.event === name && !e.seen);
        if (found) { found.seen = true; return found.data; }
        await new Promise((r) => eventWaiters.push(r));
      }
    },
    close: () => new Promise((r) => { socket.once("close", r); socket.end(); }),
  };
}

/**
 * A mac host wired to the real engine the way host.js wires it: the platform's
 * shim-owned methods, consent and agent.ask from the shared side, emit from the
 * platform, page calls from the socket into engine.handle.
 */
function rig({ records, signedIn = true } = {}) {
  const dir = tmp();
  const socketPath = path.join(dir, "apps.sock");
  const store = records || {
    vitals: { slug: "vitals", name: "Vitals", grantedVersion: 3, grants: ["menu-bar", "agent"] },
    other: { slug: "other", name: "Other", grantedVersion: 3, grants: [] },
  };
  const registry = {
    get: (slug) => store[slug] || null,
    update: (slug, patch) => { store[slug] = { ...store[slug], ...patch }; },
  };
  const calls = [];
  const statuses = [];
  const focused = [];
  const released = [];
  let isSignedIn = signedIn;
  let engine = null;
  const host = createMacHost({
    socketPath, hostVersion: "1.2.3", shimBinaryPath: "/usr/bin/true", root: path.join(dir, "Apps"),
    call: (slug, frame, msg) => engine.handle(slug, frame, msg),
    onClosed: (slug) => { if (!host.isOpen(slug)) engine.release(slug); },
    onFocus: (slug) => focused.push(slug),
    signedIn: () => isSignedIn, onStatus: (slug) => statuses.push(slug),
    uninstallApp: async (slug) => {
      calls.push(["uninstall", slug]);
      if (slug === "other") throw new Error("the bundle is locked");
      return true;
    },
    openInCodecast: async (slug) => { calls.push(["open", slug]); },
    register: false, home: path.join(dir, "home"),
  });
  const adapter = {
    consent: async (req) => { calls.push(["consent", req]); return [...req.granted, ...req.requested]; },
    "agent.ask": async (ctx, prompt) => { calls.push(["agent.ask", ctx.slug, prompt]); return { answer: `re: ${prompt}` }; },
    "shell.open": async () => null,
    "app.openInCodecast": async () => null,
    emit: (slug, event, data) => host.emit(slug, event, data),
  };
  for (const key of HOST_METHODS) if (typeof host[key] === "function") adapter[key] = host[key];
  engine = createEngine({
    registry,
    page: () => ({ version: 3, relation: "owner", policy: { install: true, fullAccess: false }, requested: [] }),
    adapter, ops: { watch: () => "w1", unwatch: () => null, unwatchAll: (slug) => released.push(slug) }, platform: "darwin",
  });
  return { dir, socketPath, host, engine, store, calls, statuses, focused, released, setSignedIn: (v) => { isSignedIn = v; host.setSignedIn(v); } };
}

test("the platform answers every shim-owned engine method with null and leaves the main-process methods to host.js", () => {
  const r = rig();
  for (const key of [...HOST_METHODS.filter((k) => !MAIN_METHODS.has(k)),
    "window.setVisibleOnAllWorkspaces", "window.setIgnoreMouseEvents"]) {
    assert.equal(r.host[key]({ slug: "vitals" }), null, key);
  }
  for (const key of MAIN_METHODS) assert.equal(r.host[key], undefined, key);
  assert.equal(r.host.name, "mac");
});

test("a shim's page calls go through the engine; refusals come back with their code", async () => {
  const r = rig();
  await r.host.serve();
  const shim = fakeShim(r.socketPath, "vitals");
  await shim.ready;
  try {
    assert.deepEqual(await shim.call("app", "badge", [2]), { id: 1, ok: true, value: null });
    assert.deepEqual(await shim.call("tray", "set", [{ title: "3" }]), { id: 2, ok: true, value: null });
    const refused = await shim.call("app", "notify", [{ title: "hi" }]);
    assert.equal(refused.code, "needs-consent");
    const stale = await shim.call("tray", "set", [{ title: "3" }], { version: 2, surface: "window" });
    assert.equal(stale.code, "mixed-version");
    const info = await shim.call("app", "info");
    assert.equal(info.value.slug, "vitals");
    assert.equal(info.value.platform, "darwin");
    assert.deepEqual(info.value.grants, ["menu-bar", "agent"]);
    // A page cannot reach a host action through a call: "host" is no cast.app module.
    assert.equal((await shim.call("host", "uninstall")).code, "unknown-method");
    assert.equal(r.calls.length, 0);
  } finally {
    await shim.close();
    await r.host.stop();
  }
});

test("agent.ask and consent run in main; a grant reaches only that app's shim", async () => {
  const r = rig();
  await r.host.serve();
  const vitals = fakeShim(r.socketPath, "vitals");
  const other = fakeShim(r.socketPath, "other");
  await Promise.all([vitals.ready, other.ready]);
  try {
    assert.deepEqual((await vitals.call("agent", "ask", ["status?"])).value, { answer: "re: status?" });
    await other.call("app", "info");
    const granted = await vitals.call("permissions", "request", [["notifications"]]);
    assert.deepEqual(granted.value, ["menu-bar", "agent", "notifications"]);
    assert.deepEqual(r.calls.map((c) => c[0]), ["agent.ask", "consent"]);
    assert.equal(r.calls[1][1].slug, "vitals");
    assert.deepEqual(await vitals.nextEvent("grants"), { grants: ["menu-bar", "agent", "notifications"], version: 3 });
    assert.equal(other.events.filter((e) => e.event === "grants").length, 0);
    assert.equal(r.store.vitals.grantedVersion, 3);
    // Version events from main go out over the socket too.
    r.host.emit("other", "version", { version: 4 });
    assert.deepEqual(await other.nextEvent("version"), { version: 4 });
  } finally {
    await Promise.all([vitals.close(), other.close()]);
    await r.host.stop();
  }
});

test("each shim hears Codecast's sign-in state when it connects and whenever it changes", async () => {
  const r = rig({ signedIn: false });
  const listening = r.host.serve();
  assert.equal(r.host.serve(), listening, "serving twice is one listener");
  await listening;
  const shim = fakeShim(r.socketPath, "vitals");
  await shim.ready;
  try {
    await shim.call("app", "info");
    assert.deepEqual(await shim.nextEvent("host-state"), { signedIn: false });
    r.setSignedIn(true);
    assert.deepEqual(await shim.nextEvent("host-state"), { signedIn: true });
    r.setSignedIn(true); // no change, no event
    await shim.call("app", "info");
    assert.equal(shim.events.filter((e) => e.event === "host-state").length, 2);
  } finally {
    await shim.close();
    await r.host.stop();
  }
});

test("host actions: report, open in Codecast, uninstall answered after it ran; a connection keeps its app", async () => {
  const r = rig();
  await r.host.serve();
  const shim = fakeShim(r.socketPath, "vitals");
  await shim.ready;
  try {
    assert.equal(r.host.anchor("vitals"), null);
    const frame = { x: 100, y: 80, width: 420, height: 640 };
    assert.equal((await shim.host("report", { notifications: "denied", frame, active: true })).ok, true);
    assert.equal(r.host.status("vitals").notifications, "denied");
    assert.equal(r.host.status("vitals").running, true);
    assert.deepEqual(r.host.anchor("vitals"), frame);
    assert.deepEqual(r.focused, ["vitals"]);
    r.host.reload("vitals");
    assert.deepEqual(await shim.nextEvent("host-reload"), {});
    assert.match(r.host.status("vitals").notificationSettingsUrl, /Notifications-Settings\.extension\?id=sh\.codecast\.app\.vitals$/);
    assert.equal((await shim.host("open-in-codecast")).ok, true);
    const reply = await shim.host("uninstall");
    assert.equal(reply.ok, true);
    assert.deepEqual(r.calls, [["open", "vitals"], ["uninstall", "vitals"]]);
    assert.equal(shim.events.some((e) => e.event === "host-quit"), false, "the asking shim is not told to quit; it exits on the reply");
    assert.equal((await shim.host("explode")).code, "unknown-method");
    const hijack = await shim.raw({ app: "other", frame: {}, msg: { module: "app", method: "info", args: [] } });
    assert.equal(hijack.code, "denied");
  } finally {
    await shim.close();
  }
  // The last connection closing releases what the app held in the engine.
  for (let i = 0; i < 50 && !r.released.length; i++) await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(r.released, ["vitals"]);
  assert.equal(r.host.status("vitals").running, false);
  assert.equal(r.host.isOpen("vitals"), false);
  assert.equal(r.host.anchor("vitals"), null);
  assert.ok(r.statuses.includes("vitals"));
  await r.host.stop();
});

test("an uninstall the shim asked for that fails answers with the reason", async () => {
  const r = rig();
  await r.host.serve();
  const shim = fakeShim(r.socketPath, "other");
  await shim.ready;
  try {
    const reply = await shim.host("uninstall");
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "failed");
    assert.match(reply.message, /the bundle is locked/);
  } finally {
    await shim.close();
    await r.host.stop();
  }
});

test("the page URL carries host=app and only the gate keys", () => {
  assert.equal(pageUrlFor("k3j2h4", { k: "abc", m: "t/1", i: "secret-identity" }),
    "https://a.codecast.sh/k3j2h4?host=app&k=abc&m=t%2F1");
  assert.equal(pageUrlFor("x", {}, "http://127.0.0.1:5/"), "http://127.0.0.1:5/x?host=app");
});

// ── bundles ──

function bundleRig() {
  const dir = tmp();
  const shim = path.join(dir, "shim");
  fs.copyFileSync("/usr/bin/true", shim);
  const png = writeSolidPng(path.join(dir, "icon.png"), 1024);
  const fetched = [];
  const make = (hostVersion, shimPath = shim, registry = null) => createMacHost({
    socketPath: path.join(dir, "apps.sock"), hostVersion, shimBinaryPath: shimPath, root: path.join(dir, "Apps"),
    register: false, home: path.join(dir, "home"), registry,
    fetchIcon: async (url) => { fetched.push(url); return fs.readFileSync(png); },
  });
  const info = (slug, name, extra = {}) => ({
    slug, title: name, version: 7,
    app: { name, window: { width: 420, height: 640 }, tray: { width: 360, height: 480 } },
    icons: { 512: `https://a.codecast.sh/${slug}?icon=512`, 1024: `https://a.codecast.sh/${slug}?icon=1024` },
    gate: { k: "key1" }, ...extra,
  });
  return { dir, shim, make, info, fetched, root: path.join(dir, "Apps") };
}

test("install writes the bundle from app info, with the 1024 icon, and keeps two same-named pages apart", { skip: !mac, timeout: 60_000 }, async () => {
  const b = bundleRig();
  const host = b.make("1.2.3");
  const first = await host.install({ record: { slug: "aaa" }, info: b.info("aaa", "Vitals") });
  const second = await host.install({ record: { slug: "bbb" }, info: b.info("bbb", "Vitals") });
  assert.equal(path.basename(first.bundlePath), "Vitals.app");
  assert.equal(path.basename(second.bundlePath), "Vitals 2.app");
  assert.deepEqual(b.fetched, ["https://a.codecast.sh/aaa?icon=1024", "https://a.codecast.sh/bbb?icon=1024"]);
  const plist = readInfo(first.bundlePath);
  assert.equal(plist.CFBundleIdentifier, "sh.codecast.app.aaa");
  assert.equal(plist.CFBundleDisplayName, "Vitals");
  assert.equal(plist.CodecastPageUrl, "https://a.codecast.sh/aaa?host=app&k=key1");
  assert.equal(plist.CodecastSocketPath, path.join(b.dir, "apps.sock"));
  assert.equal(plist.CodecastHostVersion, "1.2.3");
  assert.equal(plist.CodecastSealKey, host.sealKey());
  assert.equal(plist.CodecastWindowWidth, 420);
  assert.equal(plist.CodecastTrayHeight, 480);
  execFileSync("codesign", ["--verify", "--strict", first.bundlePath]);

  // Reinstalling keeps the bundle's path; renaming the page moves it.
  assert.equal((await host.install({ record: { slug: "aaa" }, info: b.info("aaa", "Vitals") })).bundlePath, first.bundlePath);
  const renamed = await host.install({ record: { slug: "bbb" }, info: b.info("bbb", "Pulse") });
  assert.equal(path.basename(renamed.bundlePath), "Pulse.app");
  assert.deepEqual(fs.readdirSync(b.root).sort(), ["Pulse.app", "Vitals.app"]);
  assert.equal(host.bundleFor("bbb").path, renamed.bundlePath);
});

test("resealAll skips current bundles and re-seals ones from another Codecast or shim", { skip: !mac, timeout: 60_000 }, async () => {
  const b = bundleRig();
  const old = b.make("1.0.0");
  const a = await old.install({ record: { slug: "aaa" }, info: b.info("aaa", "Vitals") });
  await old.install({ record: { slug: "bbb" }, info: b.info("bbb", "Pulse") });
  assert.deepEqual(old.resealAll().map((r) => r.resealed), [false, false]);

  const updated = b.make("1.1.0");
  const results = updated.resealAll();
  assert.deepEqual(results.map((r) => [r.slug, r.resealed]).sort(), [["aaa", true], ["bbb", true]]);
  const plist = readInfo(a.bundlePath);
  assert.equal(plist.CodecastHostVersion, "1.1.0");
  assert.equal(plist.CodecastSealKey, updated.sealKey());
  execFileSync("codesign", ["--verify", "--strict", a.bundlePath]);
  assert.deepEqual(updated.resealAll().map((r) => r.resealed), [false, false]);

  // A new shim binary under the same version is a new seal too, and lands in the bundle.
  const exe = path.join(a.bundlePath, "Contents", "MacOS", plist.CFBundleExecutable);
  const before = fs.readFileSync(exe);
  const newShim = path.join(b.dir, "shim2");
  fs.copyFileSync("/usr/bin/false", newShim);
  const reshimmed = b.make("1.1.0", newShim);
  assert.deepEqual(reshimmed.resealAll().map((r) => r.resealed), [true, true]);
  assert.notDeepEqual(fs.readFileSync(exe), before);
  execFileSync("codesign", ["--verify", "--strict", a.bundlePath]);
});

test("install writes the window options; resealAll applies changed ones from the registry's facts", { skip: !mac, timeout: 60_000 }, async () => {
  const b = bundleRig();
  const window = { width: 420, height: 640, minWidth: 320, minHeight: 400, resizable: false, titleBar: "hidden" };
  const first = b.make("1.2.3");
  const { bundlePath } = await first.install({ record: { slug: "aaa" }, info: b.info("aaa", "Vitals", { app: { name: "Vitals", window } }) });
  let plist = readInfo(bundlePath);
  assert.equal(plist.CodecastMinWidth, 320);
  assert.equal(plist.CodecastResizable, false);
  assert.equal(plist.CodecastTitleBar, "hidden");

  const facts = { aaa: { slug: "aaa", facts: { app: { window } } } };
  const host = b.make("1.2.3", b.shim, { get: (slug) => facts[slug] || null });
  assert.deepEqual(host.resealAll().map((r) => r.resealed), [false], "same seal, same options");
  facts.aaa.facts.app.window = { width: 420, height: 640, minWidth: 360, resizable: true };
  assert.deepEqual(host.resealAll().map((r) => r.resealed), [true]);
  plist = readInfo(bundlePath);
  assert.equal(plist.CodecastMinWidth, 360);
  assert.equal(plist.CodecastResizable, true);
  assert.equal("CodecastTitleBar" in plist, false);
  assert.equal("CodecastMinHeight" in plist, false);
  execFileSync("codesign", ["--verify", "--strict", bundlePath]);
  assert.deepEqual(host.resealAll().map((r) => r.resealed), [false]);
});

test("uninstall asks a running app to quit, then removes the bundle and the data kept for its bundle id", { skip: !mac, timeout: 60_000 }, async () => {
  const b = bundleRig();
  const dir = b.dir;
  const socketPath = path.join(dir, "apps.sock");
  const host = createMacHost({
    socketPath, hostVersion: "1.2.3", shimBinaryPath: b.shim, root: b.root, register: false, home: path.join(dir, "home"),
    call: (_slug, _frame, msg) => ({ id: msg.id, ok: true, value: null }),
    fetchIcon: async () => fs.readFileSync(writeSolidPng(path.join(dir, "i.png"))),
  });
  await host.serve();
  const installed = await host.install({ record: { slug: "aaa" }, info: b.info("aaa", "Vitals") });
  const data = dataPaths("aaa", path.join(dir, "home"));
  for (const p of data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); }

  const shim = fakeShim(socketPath, "aaa");
  await shim.ready;
  await shim.call("app", "info");
  const quit = shim.nextEvent("host-quit").then(() => shim.close());
  assert.equal(await host.uninstall({ slug: "aaa" }), true);
  await quit;
  assert.equal(fs.existsSync(installed.bundlePath), false);
  for (const p of data) assert.equal(fs.existsSync(p), false, p);
  assert.equal(host.bundleFor("aaa"), null);
  assert.equal(await host.uninstall("aaa"), false);
  await host.stop();
});

test("an uninstall the app's own shim asked for removes everything, then sweeps what it wrote before exiting", { skip: !mac, timeout: 60_000 }, async () => {
  const b = bundleRig();
  const socketPath = path.join(b.dir, "apps.sock");
  const home = path.join(b.dir, "home");
  let host = null;
  host = createMacHost({
    socketPath, hostVersion: "1.2.3", shimBinaryPath: b.shim, root: b.root, register: false, home,
    call: (_slug, _frame, msg) => ({ id: msg.id, ok: true, value: null }),
    fetchIcon: async () => fs.readFileSync(writeSolidPng(path.join(b.dir, "i.png"))),
    // host.js's uninstall without a record answers false; the bundle still goes.
    uninstallApp: async () => false,
  });
  await host.serve();
  const installed = await host.install({ record: { slug: "aaa" }, info: b.info("aaa", "Vitals") });
  const shim = fakeShim(socketPath, "aaa");
  await shim.ready;
  assert.equal((await shim.host("uninstall")).ok, true);
  assert.equal(fs.existsSync(installed.bundlePath), false);
  assert.equal(shim.events.some((e) => e.event === "host-quit"), false);
  // The shim's process writes its data on the way out; once it is gone the host removes it again.
  const data = dataPaths("aaa", home);
  for (const p of data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); }
  await shim.close();
  for (let i = 0; i < 100 && data.some((p) => fs.existsSync(p)); i++) await new Promise((r) => setTimeout(r, 20));
  for (const p of data) assert.equal(fs.existsSync(p), false, p);
  await host.stop();
});

test("an icon file host.js already wrote is used as is, with no fetch", { skip: !mac, timeout: 60_000 }, async () => {
  const b = bundleRig();
  const host = b.make("1.2.3");
  const png = writeSolidPng(path.join(b.dir, "written.png"), 1024, [200, 40, 40]);
  await host.install({ record: { slug: "ccc" }, info: b.info("ccc", "Red"), icons: { png } });
  assert.deepEqual(b.fetched, []);
});
