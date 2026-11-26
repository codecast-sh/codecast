// Run: APPSHIM_E2E=1 node --test packages/electron/appshim/e2e.test.js
// Builds the real shim, installs it into a temp root, launches it against a
// local page and the stand-in engine, and checks every bridge call the page
// makes. It opens a real window (and a menu bar item for a moment), so it only
// runs when asked. Notifications are left out: the first one asks the person.
// It also checks the gates: a subframe (on the page's path or a sibling path)
// is refused by the bridge without reaching the engine, a page navigating to
// ssh:// or file:// is cancelled and nothing is opened, and a dropped socket
// is reconnected without a call, re-identified and the grants re-sent.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { install, uninstall } = require("./install");
const { startTestEngine, defaultAnswer } = require("./testServer");
const { fail } = require("../installedApps/protocol");
const { writeSolidPng, countColorPixels } = require("./fixtures");

// A same-origin subframe that skips the page client and posts to the handler directly.
const FRAME = `<!doctype html><script>
(async () => {
  const handler = window.webkit && webkit.messageHandlers && webkit.messageHandlers.castApp;
  let reply = null;
  try { reply = handler && await handler.postMessage({ module: "app", method: "badge", args: [99] }); }
  catch (e) { reply = { thrown: String(e) }; }
  await fetch("/frame-result", { method: "POST", body: JSON.stringify({ path: location.pathname, has: !!handler, reply }) });
})();
</script>`;

const PAGE = `<!doctype html><title>e2e</title>
<iframe src="/e2e-app/frame"></iframe><iframe src="/e2e-app-evil/frame"></iframe><script>
(async () => {
  const out = { hasApp: !!(window.cast && window.cast.app) };
  const post = (p, body) => fetch(p, { method: "POST", body: JSON.stringify(body) });
  const app = window.cast.app;
  app.on("grants", (data) => post("/event", data));
  const step = async (name, fn) => {
    try { out[name] = { ok: true, value: await fn() }; } catch (e) { out[name] = { ok: false, code: e.code }; }
  };
  await step("info", () => app.info());
  await step("badge", () => app.badge(2));
  await step("tray", () => app.tray.set({ title: "e2e", tooltip: "e2e" }));
  await step("shortcut", () => app.shortcuts.register("CmdOrCtrl+Alt+Shift+F19"));
  await step("badShortcut", () => app.shortcuts.register("CmdOrCtrl+Shift+Banana"));
  await step("onTop", () => app.window.setAlwaysOnTop(true));
  await step("refused", () => app.fs.readText("/etc/hosts"));
  await step("trayOff", () => app.tray.remove());
  await step("badgeOff", () => app.badge(0));
  for (const href of ["ssh://example.invalid", "file:///etc/hosts"]) {
    location.href = href;
    await new Promise((r) => setTimeout(r, 400));
  }
  out.stillHere = location.pathname;
  await post("/result", out);
})();
</script>`;

test("the shim carries a page's bridge calls to the engine and performs the OS half",
  { skip: process.env.APPSHIM_E2E !== "1" || process.platform !== "darwin", timeout: 180_000 }, async () => {
    execFileSync(path.join(__dirname, "build.sh"), { stdio: "inherit" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "as-e2e-"));
    const socketPath = path.join(dir, "apps.sock");
    const engine = startTestEngine({
      socketPath,
      decide: (env) => env.msg.module === "fs" ? fail(env.msg.id, "needs-consent", "not granted") : defaultAnswer(env),
    });
    await engine.ready;

    // Each POST path is a queue the test awaits in order.
    const posts = {};
    const queue = (name) => (posts[name] ||= { items: [], waiters: [] });
    const next = (name) => {
      const q = queue(name);
      return q.items.length ? Promise.resolve(q.items.shift()) : new Promise((r) => q.waiters.push(r));
    };
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (req.method === "POST") {
          const q = queue(req.url.slice(1));
          const value = JSON.parse(body);
          q.waiters.length ? q.waiters.shift()(value) : q.items.push(value);
        }
        res.setHeader("content-type", "text/html");
        res.setHeader("x-cast-version", "7");
        res.end(req.method !== "GET" ? "ok" : req.url.endsWith("/frame") ? FRAME : PAGE);
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const pageUrl = `http://127.0.0.1:${server.address().port}/e2e-app`;

    const app = install({
      slug: "e2e-appshim", name: "Appshim E2E", iconPngPath: writeSolidPng(path.join(dir, "icon.png")),
      pageUrl, socketPath, shimBinaryPath: path.join(__dirname, "build", "CodecastAppShim"), root: path.join(dir, "Apps"),
      window: { width: 480, height: 360 },
    });
    const stderr = path.join(dir, "shim.log");
    let pid;
    try {
      execFileSync("open", ["-n", "-g", "--stderr", stderr, app.path]);
      const out = await next("result");
      pid = Number(/"pid"=(\d+)/.exec(execFileSync("lsappinfo", ["info", "-only", "pid", app.bundleId]).toString())?.[1]);
      assert.equal(out.hasApp, true);
      assert.deepEqual(out.info, {
        ok: true,
        value: { slug: "e2e-appshim", name: "e2e-appshim", version: 7, surface: "window", platform: "darwin",
          grants: ["notifications", "menu-bar", "shortcuts", "overlay"], requested: [],
          notifications: out.info.value.notifications,
          notificationSettingsUrl: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=sh.codecast.app.e2e-appshim" },
      });
      assert.ok(["not-determined", "denied", "authorized", "provisional"].includes(out.info.value.notifications));
      for (const step of ["badge", "tray", "shortcut", "onTop", "trayOff", "badgeOff"]) assert.equal(out[step].ok, true, step);
      assert.deepEqual(out.badShortcut, { ok: false, code: "failed" });
      assert.deepEqual(out.refused, { ok: false, code: "needs-consent" });
      // The shim's own reports to the host carry no frame; page calls all do.
      const pageCalls = () => engine.calls.filter((env) => !env.host);
      for (const env of pageCalls()) {
        assert.equal(env.app, "e2e-appshim");
        assert.deepEqual(env.frame, { version: 7, surface: "window" });
      }

      // Subframes are refused before the engine sees them.
      const frames = [await next("frame-result"), await next("frame-result")].sort((a, b) => a.path.localeCompare(b.path));
      assert.deepEqual(frames.map((f) => f.path), ["/e2e-app-evil/frame", "/e2e-app/frame"]);
      for (const f of frames) {
        assert.equal(f.has, true, `${f.path} sees the handler`);
        assert.equal(f.reply?.ok, false, f.path);
        assert.equal(f.reply?.code, "denied", f.path);
      }
      assert.ok(!engine.calls.some((env) => env.msg.args?.[0] === 99), "no subframe call reached the engine");

      // Off-path navigation to a non-web scheme is cancelled and not opened.
      assert.equal(out.stillHere, "/e2e-app");
      const log = fs.readFileSync(stderr, "utf8");
      assert.match(log, /refused to open ssh:\/\/example\.invalid/);

      engine.push("grants", { grants: ["notifications"] });
      assert.deepEqual(await next("event"), { grants: ["notifications"] });

      // A dropped socket comes back on its own and the page hears the current grants.
      const before = pageCalls().length;
      engine.dropAll();
      assert.deepEqual(await next("event"),
        { grants: ["notifications", "menu-bar", "shortcuts", "overlay"], version: 7 });
      const again = pageCalls().slice(before);
      assert.deepEqual(again.map((env) => `${env.msg.module}.${env.msg.method}`), ["app.info"]);
      assert.deepEqual(again[0].frame, { version: 7, surface: "window" });
    } finally {
      if (pid) { try { process.kill(pid); } catch {} }
      uninstall({ name: "Appshim E2E", slug: "e2e-appshim", root: path.join(dir, "Apps") });
      server.closeAllConnections();
      server.close();
      await engine.close();
    }
  });

// The same shim against the real host: host.js with its registry, the one
// engine (and fullAccess.js for files and programs) and macHost.js serving the
// socket. host.install() asks consent (answered here), builds the bundle from
// the app info with the icon fetched from the page's icon URL, and opens it.
const HOST_PAGE = `<!doctype html><title>host e2e</title><script>
(async () => {
  const post = (p, body) => fetch(p, { method: "POST", body: JSON.stringify(body) });
  const app = window.cast.app;
  const out = { ua: navigator.userAgent };
  app.on("version", (data) => post("/event", { event: "version", data }));
  const step = async (name, fn) => {
    try { out[name] = { ok: true, value: await fn() }; } catch (e) { out[name] = { ok: false, code: e.code, message: e.message }; }
  };
  await step("info", () => app.info());
  await step("badge", () => app.badge(4));
  await step("read", () => app.fs.readText(new URLSearchParams(location.search).get("file") || "/nonexistent"));
  await step("run", () => app.process.run("/bin/echo", ["from", "main"]));
  await step("ask", () => app.agent.ask("what is up?"));
  await step("onTop", () => app.window.setAlwaysOnTop(true));
  await step("notGranted", () => app.shortcuts.register("CmdOrCtrl+Alt+Shift+F18"));
  await step("badgeOff", () => app.badge(0));
  await post("/result", out);
})();
</script>`;

test("the shim works against the real engine through host.js and macHost.js",
  { skip: process.env.APPSHIM_E2E !== "1" || process.platform !== "darwin", timeout: 180_000 }, async () => {
    execFileSync(path.join(__dirname, "build.sh"), { stdio: "inherit" });
    const { createAppsHost } = require("../installedApps/host");
    const { createRegistry } = require("../installedApps/registry");
    const { createMacHost } = require("../installedApps/macHost");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "as-host-"));
    const socketPath = path.join(dir, "apps.sock");
    const root = path.join(dir, "Apps");
    const secret = path.join(dir, "secret.txt");
    fs.writeFileSync(secret, "only main reads this");
    const iconPng = fs.readFileSync(writeSolidPng(path.join(dir, "icon.png"), 1024, [230, 120, 30]));

    let version = 7;
    const posts = {};
    const queue = (name) => (posts[name] ||= { items: [], waiters: [] });
    const next = (name) => {
      const q = queue(name);
      return q.items.length ? Promise.resolve(q.items.shift()) : new Promise((r) => q.waiters.push(r));
    };
    const loads = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (req.method === "POST") {
          const q = queue(req.url.slice(1));
          const value = JSON.parse(body);
          q.waiters.length ? q.waiters.shift()(value) : q.items.push(value);
          return res.end("ok");
        }
        if (req.url.includes("icon=")) { res.setHeader("content-type", "image/png"); return res.end(iconPng); }
        loads.push({ url: req.url, ua: req.headers["user-agent"], version });
        res.setHeader("content-type", "text/html");
        res.setHeader("x-cast-version", String(version));
        res.end(HOST_PAGE);
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const slug = "host-e2e-app";

    let settings = {};
    const registry = createRegistry({
      settings: { load: () => settings, update: (patch) => { settings = { ...settings, ...patch }; } },
      sealer: { seal: (t) => t, open: (t) => t },
    });
    const consents = [];
    const asked = [];
    let platform;
    const appsHost = createAppsHost({
      registry,
      consent: {
        ask: async (request) => { consents.push(request); return { grants: request.asked }; },
        cancelAll() {}, get() {}, answer() {},
      },
      ipc: { handle() {}, on() {} },
      broadcast() {},
      pageOrigin: origin,
      askAgent: async (s, prompt) => { asked.push([s, prompt]); return { answer: "all good" }; },
      shell: { openExternal: async () => {}, openPath: async () => "" },
      createPlatform: (d) => (platform = createMacHost({
        ...d, socketPath, hostVersion: "9.8.7", root, pageOrigin: origin,
        shimBinaryPath: path.join(__dirname, "build", "CodecastAppShim"),
        uninstallApp: (s) => appsHost.uninstall(s),
      })),
      log: () => {},
    });
    appsHost.start();
    await platform.serve();

    const info = {
      slug, title: "Host E2E", version, updated_at: Date.now(),
      app: { name: "Host E2E", icon: null, window: { width: 520, height: 420, minWidth: 320, minHeight: 300, resizable: true, titleBar: "default" },
        tray: { icon: null, width: 360, height: 480, tooltip: "Host E2E" }, permissions: ["overlay", "agent", "full-access"] },
      owner: { name: "Test" }, icons: { 1024: `${origin}/${slug}?icon=1024` },
      relation: "owner", policy: { install: true, fullAccess: true }, gate: { k: "gatekey" },
    };
    let pid;
    const stderr = path.join(dir, "shim.log");
    try {
      // host.install opens the app with `open`; this test opens it itself to catch the shim's log.
      platform.open = async () => {};
      assert.deepEqual(await appsHost.install(info), { installed: true, slug });
      assert.deepEqual(consents.map((c) => c.kind), ["install"]);
      const bundle = platform.bundleFor(slug);
      assert.equal(path.basename(bundle.path), "Host E2E.app");
      assert.equal(bundle.info.CodecastPageUrl, `${origin}/${slug}?host=app&k=gatekey`);
      assert.equal(bundle.info.CodecastHostVersion, "9.8.7");
      assert.deepEqual(registry.get(slug).grants, ["overlay", "agent", "full-access"]);
      assert.equal(registry.get(slug).bundlePath, bundle.path);

      // The page needs the secret file's path; the gate keys ride along.
      execFileSync("plutil", ["-replace", "CodecastPageUrl", "-string", `${origin}/${slug}?host=app&k=gatekey&file=${encodeURIComponent(secret)}`,
        path.join(bundle.path, "Contents", "Info.plist")]);
      execFileSync("codesign", ["--force", "--sign", "-", bundle.path], { stdio: "pipe" });
      execFileSync("open", ["-n", "-g", "--stderr", stderr, "--env", `CODECAST_APPSHIM_DEBUG_DIR=${dir}`, bundle.path]);

      const out = await next("result");
      pid = Number(/"pid"=(\d+)/.exec(execFileSync("lsappinfo", ["info", "-only", "pid", "sh.codecast.app." + slug]).toString())?.[1]);
      // The menus as built (AppKit's Edit extras once each, read after its later passes: a snapshot rewrites menu.txt), and the Dock menu.
      process.kill(pid, "SIGUSR2");
      const snapped = Date.now() + 5000;
      while (!/snapshot window-frame/.test(fs.readFileSync(stderr, "utf8")) && Date.now() < snapped) await new Promise((r) => setTimeout(r, 100));
      const menu = fs.readFileSync(path.join(dir, "menu.txt"), "utf8").split("\n").map((l) => l.trim());
      for (const title of ["Start Dictation…", "Emoji & Symbols", "Settings…", "Show in Codecast", "Reload Page", "Zoom In", "Zoom Out", "Enter Full Screen"]) {
        assert.equal(menu.filter((l) => l === title).length, 1, title);
      }
      assert.ok(!menu.includes("Show Tab Bar"), "window tabbing is off");
      assert.deepEqual(fs.readFileSync(path.join(dir, "dock-menu.txt"), "utf8").split("\n"), ["Show in Codecast"]);

      // About shows the app's own icon (the bundle's app.icns, orange here), not Codecast's.
      fs.writeFileSync(path.join(dir, "pick.txt"), "About");
      const logBefore = fs.readFileSync(stderr, "utf8").length;
      process.kill(pid, "SIGINFO");
      const shown = Date.now() + 5000;
      while (!/pick About/.test(fs.readFileSync(stderr, "utf8").slice(logBefore)) && Date.now() < shown) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 800));
      process.kill(pid, "SIGUSR2");
      let aboutShot;
      const aboutBy = Date.now() + 5000;
      while (!aboutShot && Date.now() < aboutBy) {
        await new Promise((r) => setTimeout(r, 100));
        // The About panel is the captured window with no title.
        aboutShot = /captured (screen-\d+\.png)  layer/.exec(fs.readFileSync(stderr, "utf8").slice(logBefore))?.[1];
      }
      assert.ok(aboutShot, "the About panel was captured");
      assert.ok(countColorPixels(path.join(dir, aboutShot), [230, 120, 30], 24) > 4000, "the About panel shows the app's icon");
      assert.match(out.ua, / CodecastApp\/9\.8\.7 \(host-e2e-app\)$/);
      assert.match(loads[0].ua, / CodecastApp\/9\.8\.7 \(host-e2e-app\)$/, "the document request carries the user agent too");
      assert.match(loads[0].url, /host=app/);
      assert.match(loads[0].url, /k=gatekey/);
      assert.equal(out.info.ok, true);
      assert.equal(out.info.value.version, 7);
      assert.deepEqual(out.info.value.grants, ["overlay", "agent", "full-access"]);
      assert.ok(["not-determined", "denied", "authorized", "provisional"].includes(out.info.value.notifications), out.info.value.notifications);
      assert.equal(out.info.value.notificationSettingsUrl,
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=sh.codecast.app.host-e2e-app");
      assert.deepEqual(out.read, { ok: true, value: "only main reads this" });
      assert.equal(out.run.value.stdout, "from main\n");
      assert.equal(out.run.value.code, 0);
      assert.deepEqual(out.ask, { ok: true, value: { answer: "all good" } });
      assert.deepEqual(asked, [[slug, "what is up?"]]);
      assert.equal(out.onTop.ok, true);
      assert.equal(out.notGranted.code, "needs-consent");
      for (const s of ["badge", "badgeOff"]) assert.equal(out[s].ok, true, s);
      assert.equal(platform.isOpen(slug), true);

      // A republish: the page hears the version, then the host reloads it.
      version = 8;
      appsHost.takeFacts(slug, { ...info, version: 8, gate: undefined });
      assert.deepEqual(await next("event"), { event: "version", data: { version: 8 } });
      const reloaded = await next("result");
      assert.equal(reloaded.info.value.version, 8);
      assert.equal(loads.at(-1).version, 8);

      // Signed out: the shim covers the page and says so.
      platform.setSignedIn(false);
      const deadline = Date.now() + 5000;
      while (!/host state signedOut/.test(fs.readFileSync(stderr, "utf8")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.match(fs.readFileSync(stderr, "utf8"), /host state signedOut/);
      platform.setSignedIn(true);

      // Uninstall: the running app quits, the bundle and the record go.
      assert.equal(await appsHost.uninstall(slug), true);
      assert.equal(fs.existsSync(bundle.path), false);
      assert.equal(registry.get(slug), null);
      const { LSREGISTER } = require("./install");
      assert.doesNotMatch(execFileSync(LSREGISTER, ["-dump"], { maxBuffer: 512 * 1024 * 1024 }).toString(), new RegExp(`path: +${bundle.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        "Launch Services forgot the bundle");
      const gone = Date.now() + 5000;
      while (Date.now() < gone) {
        try { process.kill(pid, 0); } catch { pid = null; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(pid, null, "the shim quit");
    } finally {
      if (pid) { try { process.kill(pid); } catch {} }
      if (platform.bundleFor(slug)) await platform.uninstall(slug).catch(() => {});
      appsHost.stop();
      await platform.stop();
      server.closeAllConnections();
      server.close();
    }
  });
