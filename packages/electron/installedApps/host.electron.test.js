// Run: node --test packages/electron/installedApps/host.electron.test.js
//
// The installed-app host end to end in a real Electron, from source: main.js
// boots with its own profile (CODECAST_USER_DATA, so it never touches the
// installed Codecast or takes its single-instance lock) and the Electron-window
// host (CODECAST_APPS_HOST=electron), against two local servers: one plays
// the codecast web app (the shell), the other plays a.codecast.sh (the page,
// its ?app=1 facts and its icon). The test drives every window over the
// DevTools protocol the from-source run opens:
//
//   shell   apps.install(info) opens the install sheet
//   sheet   apps.consent.get/answer approves it, as the /apps/consent route will
//   app     the page calls cast.app (info, window, files, programs) through the
//           sandboxed preload, the engine and the host
//   shell   apps.facts with a new version reloads the app and re-asks; apps.list
//           shows the review; apps.uninstall removes it all
//
// CODECAST_APPS_SHOW=1 shows the app window (it is off screen by default);
// CODECAST_APPS_SHOTS=<dir> saves screenshots of the app window there.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { solidPng } = require("./testPng");

const SLUG = "apptest01";
const ELECTRON_DIR = path.join(__dirname, "..");

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/** A DevTools protocol session on one target. */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  // An evaluate that lands while the target is between documents can go
  // unanswered, so every command gives up after a while and the caller retries.
  const send = (method, params = {}, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).catch((err) => {
        throw new Error(`${err.message}: ${expression.slice(0, 120)}`);
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

test("install, call, republish and uninstall an app in the Electron-window host", { skip: process.platform === "linux" ? "main.js boots only on macOS and Windows" : false, timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-e2e-"));
  const userData = path.join(dir, "profile");
  const scratch = path.join(dir, "scratch.txt");
  let version = 7;
  const icon = solidPng(1024, [60, 110, 200, 255]);

  const shell = await listen((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>shell</title><body>shell</body>");
  });
  const page = await listen((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.searchParams.has("icon")) {
      res.setHeader("Content-Type", "image/png");
      return res.end(icon);
    }
    if (url.pathname === `/${SLUG}`) {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Cast-Version", String(version));
      return res.end(`<!doctype html><html><head><title>Test app</title></head>
<body style="margin:0;font:16px -apple-system,system-ui;background:#0f1720;color:#e6edf3;display:grid;place-items:center;height:100vh">
<main><h1 style="margin:0 0 8px">Test app</h1><p id="v">version ${version}</p><p id="ua"></p></main>
<script>window.__loadedVersion = ${version}; document.getElementById("ua").textContent = navigator.userAgent.split(" ").slice(-2).join(" ");</script>
</body></html>`);
    }
    res.statusCode = 404;
    res.end("not here");
  });

  const info = (v) => ({
    slug: SLUG,
    title: "Test app",
    version: v,
    updated_at: Date.now(),
    app: {
      name: "Test App",
      icon: null,
      window: { width: 480, height: 360, minWidth: 320, minHeight: 240, resizable: true, titleBar: "default" },
      tray: { icon: null, width: 320, height: 240, tooltip: "Test App" },
      permissions: ["notifications", "full-access"],
    },
    owner: { name: "Test" },
    icons: { 512: `${page.origin}/${SLUG}?icon=512&k=key1`, 1024: `${page.origin}/${SLUG}?icon=1024&k=key1` },
    relation: "owner",
    policy: { install: true, fullAccess: true },
    gate: { k: "key1" },
  });

  const port = await freePort();
  const show = process.env.CODECAST_APPS_SHOW === "1";
  const child = spawn(require("electron"), [ELECTRON_DIR, "--background"], {
    env: {
      ...process.env,
      CODECAST_USER_DATA: userData,
      CODECAST_URL: shell.origin,
      CODECAST_APPS_HOST: "electron",
      CODECAST_APPS_PAGE_ORIGIN: page.origin,
      CODECAST_APPS_SHOW: show ? "1" : "0",
      CODECAST_CDP_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page");
  const target = (what, pred, timeoutMs) => until(what, async () => (await targets()).find(pred), timeoutMs);
  const sessions = [];
  const open = async (t) => {
    const s = await attach(t.webSocketDebuggerUrl);
    sessions.push(s);
    return s;
  };

  try {
    const shellPage = await open(await target("the shell window", (t) => t.url.startsWith(`${shell.origin}/inbox`), 60_000));
    // A target names its URL before that document's preload has run.
    await until("the shell bridge", () => shellPage.eval("typeof window.__CODECAST_ELECTRON__?.apps?.install === 'function'"));
    assert.deepEqual(await shellPage.eval("window.__CODECAST_ELECTRON__.apps.list()"), []);

    // Install: the sheet opens, the route reads the request and approves it.
    await shellPage.eval(`window.__install = window.__CODECAST_ELECTRON__.apps.install(${JSON.stringify(info(7))}); true`);
    const sheetTarget = await target("the install sheet", (t) => t.url.startsWith(`${shell.origin}/apps/consent/`));
    const sheet = await open(sheetTarget);
    await until("the sheet bridge", () => sheet.eval("!!window.__CODECAST_ELECTRON__?.apps"));
    const id = decodeURIComponent(sheetTarget.url.split("/apps/consent/")[1]);
    const request = await sheet.eval(`window.__CODECAST_ELECTRON__.apps.consent.get(${JSON.stringify(id)})`);
    assert.equal(request.kind, "install");
    assert.deepEqual(request.asked, ["notifications", "full-access"]);
    assert.equal(request.info.slug, SLUG);
    // The sheet closes once answered, so the answer's own reply may never get back over CDP.
    await sheet.eval(`window.__CODECAST_ELECTRON__.apps.consent.answer(${JSON.stringify(id)}, {approve: true, grants: ["notifications", "full-access"]}); true`);
    assert.deepEqual(await shellPage.eval("window.__install"), { installed: true, slug: SLUG });

    // The app window: its page, its partition, its bridge.
    const appTarget = await target("the app window", (t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=window&k=key1`));
    const appPage = await open(appTarget);
    await until("the page", () => appPage.eval("window.__loadedVersion === 7"));
    const ua = await appPage.eval("navigator.userAgent");
    assert.match(ua, new RegExp(` CodecastApp/[^ ]+ \\(${SLUG}\\)$`));
    const appInfo = await appPage.eval("cast.app.info()");
    assert.deepEqual({ ...appInfo, platform: undefined }, { slug: SLUG, name: "Test App", version: 7, surface: "window", platform: undefined, grants: ["notifications", "full-access"], requested: ["notifications", "full-access"] });
    await appPage.eval("cast.app.window.setTitle('Test App: ready')");
    await appPage.eval(`cast.app.fs.writeText(${JSON.stringify(scratch)}, "written by the app")`);
    assert.equal(fs.readFileSync(scratch, "utf8"), "written by the app");
    assert.equal(await appPage.eval(`cast.app.fs.readText(${JSON.stringify(scratch)})`), "written by the app");
    if (process.platform !== "win32") {
      const run = await appPage.eval("cast.app.process.run('/bin/echo', ['hello'])");
      assert.equal(run.code, 0);
      assert.equal(run.stdout.trim(), "hello");
    }
    const refused = await appPage.eval("cast.app.tray.set({title: 'x'}).then(() => null, (e) => e.code)");
    assert.equal(refused, "needs-consent", "menu-bar was not granted");
    // Off-path navigation never happens in the window.
    await appPage.eval(`location.href = ${JSON.stringify(`${page.origin}/elsewhere`)}; true`).catch(() => {});
    await sleep(500);
    assert.equal(await appPage.eval("location.pathname"), `/${SLUG}`);

    if (process.env.CODECAST_APPS_SHOTS) {
      const shot = await appPage.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(process.env.CODECAST_APPS_SHOTS, "app-window.png"), Buffer.from(shot.data, "base64"));
    }

    const settings = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    const record = settings.installedApps[SLUG];
    assert.equal(record.name, "Test App");
    assert.equal(record.grantedVersion, 7);
    assert.ok(!JSON.stringify(record.gate).includes("key1"), "the gate key is sealed with safeStorage");
    assert.ok(fs.existsSync(record.iconPath), "the icon was fetched");
    assert.ok(fs.existsSync(record.icons.tray), "a tray image was drawn");

    // A republish: the app reloads to version 8, its grants go stale, and it re-asks.
    version = 8;
    await shellPage.eval(`window.__CODECAST_ELECTRON__.apps.facts(${JSON.stringify(SLUG)}, ${JSON.stringify(info(8))}); true`);
    const reviewTarget = await target("the review sheet", (t) => t.url.startsWith(`${shell.origin}/apps/consent/`) && t.id !== sheetTarget.id);
    const review = await open(reviewTarget);
    await until("the review sheet bridge", () => review.eval("!!window.__CODECAST_ELECTRON__?.apps"));
    const reviewId = decodeURIComponent(reviewTarget.url.split("/apps/consent/")[1]);
    assert.equal((await review.eval(`window.__CODECAST_ELECTRON__.apps.consent.get(${JSON.stringify(reviewId)})`)).kind, "review");
    const reloaded = await open(await target("the reloaded app", (t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=window`)));
    await until("version 8 loaded", () => reloaded.eval("window.__loadedVersion === 8"));
    const listed = await shellPage.eval("window.__CODECAST_ELECTRON__.apps.list()");
    assert.equal(listed[0].needsReview, true);
    assert.equal((await reloaded.eval("cast.app.info()")).version, 8);
    assert.equal(await reloaded.eval(`cast.app.fs.readText(${JSON.stringify(scratch)}).then(() => null, (e) => e.code)`), "needs-consent");
    // Approving the re-ask restores the calls.
    await review.eval(`window.__CODECAST_ELECTRON__.apps.consent.answer(${JSON.stringify(reviewId)}, {approve: true, grants: ["full-access"]}); true`);
    await until("grants for version 8", async () => (await shellPage.eval("window.__CODECAST_ELECTRON__.apps.list()"))[0].grantedVersion === 8);
    assert.equal(await reloaded.eval(`cast.app.fs.readText(${JSON.stringify(scratch)})`), "written by the app");

    // Uninstall: the window goes, and so does the record.
    assert.equal(await shellPage.eval(`window.__CODECAST_ELECTRON__.apps.uninstall(${JSON.stringify(SLUG)})`), true);
    await until("the app window to close", async () => !(await targets()).some((t) => t.url.startsWith(`${page.origin}/${SLUG}`)));
    assert.deepEqual(await shellPage.eval("window.__CODECAST_ELECTRON__.apps.list()"), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).installedApps, {});
  } catch (err) {
    err.message += `\n--- electron output ---\n${output.slice(-4000)}`;
    throw err;
  } finally {
    for (const s of sessions) s.close();
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    shell.server.close();
    page.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
