#!/usr/bin/env -S node --no-warnings
// The installed-apps flow end to end on this computer
// (docs/architecture/installed-apps.md, plan pl-1104), against Codecast's real
// main.js from source:
//
//   node --no-warnings packages/electron/installedApps/e2e/run.mjs [--host mac|electron|both] [--shots <dir>] [--keep] [--real-root [--await-grant <min>]] [--strict]
//   node --no-warnings packages/electron/installedApps/e2e/run.mjs --prod --slug <slug> [--k <key>]   after a deploy
//
// What runs:
//   - e2e/standin.mjs plays a.codecast.sh, serving examples/installed-apps/needs-you
//     as e2eneedsyou (gated with k=e2ekey): the version header, the host user
//     agent rule, ?app=1 facts, icons, live data it can change, and a republish
//     that bumps the version and adds a permission. With --prod the page origin
//     is the real https://a.codecast.sh and the page's own published version.
//   - A small local server plays the codecast web app (the shell). It is the
//     window that holds window.__CODECAST_ELECTRON__.apps, so the harness calls
//     apps.install(info), apps.facts and apps.uninstall there, as the web
//     app's install sheet and facts hook will. The real /apps/consent route is
//     not served: the harness answers each consent window through
//     apps.consent.get/answer, which is what that route calls.
//   - main.js boots from source with its own profile (CODECAST_USER_DATA), its
//     DevTools port for the shell and app windows, and its Node inspector,
//     through which the harness reads what the Electron host did (tray titles,
//     notifications, shortcuts) and keeps it from opening the default browser.
//   - Each host in turn: the macOS shim (the default on a Mac; bundles go to a
//     temp root, never ~/Applications/Codecast Apps, and name Electron.app as
//     their host, never the installed Codecast) and the Electron-window host
//     (CODECAST_APPS_HOST=electron, what Windows runs).
//   - The page runs e2e/probe.js, which lets the harness run code in it under
//     either host (a WKWebView has no DevTools protocol).
//
// Per host it checks: an install refused when the team turned installs off;
// the install sheet's request and the registry row; the
// bundle (macOS: test root, Info.plist, seal, lsappinfo name and bundle id) or
// the window and its partition; cast.app.info(); the host user agent, no bar
// and working storage; the count on the Dock badge and the menu bar title; one
// notification asked of the OS per new item (delivery is a blocked gate unless
// --real-root, where it is a check); the tray popover at surface=tray; an item opening
// in Codecast's main window; the shim's menu (Show in Codecast, Settings…);
// the navigation lock; a second app beside it (own storage, its own shortcut,
// overlay pin, uninstalled alone); a republish (version event, reload, every
// permission needing consent until the review is answered, then a shortcut); a
// page ahead of the facts refused with mixed-version, and a one-tap re-ask; a
// Codecast restart; signing out and in; uninstall (bundle, Launch Services
// record, app data or partition storage, record); and a reinstall.
//
// Screenshots go to --shots (default ~/.codecast/tmp/installed-apps-e2e).
// Exit status 0 only when every check passed (3 with --strict while a gate is
// blocked: a check this computer cannot prove without a person, such as
// macOS delivering a notification, which needs --real-root and a grant). Every process, bundle, Launch
// Services record, app data folder and temp dir it made is removed at the end
// (--keep leaves the temp dir).
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStandin, HOST_CSP, BAR_MARKER, HOST_UA_RE } from "./standin.mjs";

const require = createRequire(import.meta.url);
const { sleep, until, freePort, listen, attach } = require("./cdp.js");
const installer = require("../../appshim/install.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.join(HERE, "../..");
const electronBin = require(path.join(ELECTRON_DIR, "node_modules/electron"));

// ── arguments ──
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const PROD = argv.includes("--prod");
const KEEP = argv.includes("--keep");
// Bundles in the real ~/Applications/Codecast Apps, named "E2E …" so they are
// never mistaken for (or replace) the person's own; removed at the end.
const REAL_ROOT = argv.includes("--real-root");
// Exit nonzero while any gate is blocked (notification delivery needs a person's grant).
const STRICT = argv.includes("--strict");
// With --real-root: how long the delivery check keeps the app installed and
// re-asks while a person allows it in System Settings > Notifications.
const AWAIT_GRANT_MS = Number(flag("--await-grant") || 0) * 60_000;
const HOSTS = (flag("--host") || (process.platform === "darwin" ? "both" : "electron")) === "both" ? ["mac", "electron"] : [flag("--host")];
const SHOTS = flag("--shots") || path.join(os.homedir(), ".codecast/tmp/installed-apps-e2e");
const SLUG = PROD ? flag("--slug") : "e2eneedsyou";
// Stand-in pages: one declaring no icon, one whose team turned installs off.
const NOICON = "e2enoicon";
const BLOCKED = "e2eblocked";
const KEY = PROD ? flag("--k") : "e2ekey";
if (PROD && !SLUG) {
  console.error("--prod needs --slug <slug> of a published page (and --k <key> for a gated one)");
  process.exit(2);
}
if (HOSTS.includes("mac") && process.platform !== "darwin") {
  console.error("the mac host runs only on macOS");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });

// ── results ──
const results = [];
let currentHost = "-";
const say = (...a) => console.log(`[${currentHost}]`, ...a);
/** Runs one check; a failure throws on, ending this host's pass, unless soft. */
async function check(name, fn, { soft = false } = {}) {
  const started = Date.now();
  try {
    const value = await fn();
    const detail = typeof value === "string" ? value : "";
    results.push({ host: currentHost, name, status: "pass", detail });
    say(`ok    ${name}${detail ? `  (${detail})` : ""}  ${Date.now() - started}ms`);
    return value;
  } catch (err) {
    results.push({ host: currentHost, name, status: soft ? "soft-fail" : "fail", detail: err.message });
    say(`FAIL  ${name}: ${err.message}`);
    if (!soft) throw err;
  }
}
/** A gate this run could not prove and that a person must open (a macOS
 * grant, a deploy). Never a pass: the summary names it, and --strict fails on it. */
const blocked = (name, why) => {
  results.push({ host: currentHost, name, status: "blocked", detail: why });
  say(`BLOCK ${name}: ${why}`);
};
const skip = (name, why) => {
  results.push({ host: currentHost, name, status: "skip", detail: why });
  say(`skip  ${name}: ${why}`);
};
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const eq = (a, b, what) => assert(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const shot = (name, png) => {
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, png);
  return file;
};

// ── the page origin: the stand-in, or a.codecast.sh ──
const PAGE_ORIGIN = PROD ? "https://a.codecast.sh" : null;
const gateQs = KEY ? `&k=${encodeURIComponent(KEY)}` : "";
/** Whether `url` is the app's page on `origin` at `surface`: /<slug>, or /<slug>/ where a bundle's redirect lands. */
function isPageUrl(url, origin, surface) {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  return u.origin === origin && (u.pathname === `/${SLUG}` || u.pathname === `/${SLUG}/`) && u.searchParams.get("host") === "app" && u.searchParams.get("surface") === surface;
}
const PAGE_PATHS = [`/${SLUG}`, `/${SLUG}/`];

/** The contract checks a.codecast.sh (or the stand-in) must pass over plain HTTP. */
async function serverChecks(origin) {
  currentHost = "server";
  const hostUa = `Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) CodecastApp/9.9.9 (${SLUG})`;
  const doc = (ua) => fetch(`${origin}/${SLUG}/?host=app&surface=window${gateQs}`, { headers: ua ? { "User-Agent": ua } : {}, redirect: "manual" });
  await check("a bundle's bare slug redirects to its folder, keeping the query", async () => {
    const r = await fetch(`${origin}/${SLUG}?host=app${gateQs}`, { redirect: "manual" });
    eq(r.status, 301, "status");
    eq(new URL(r.headers.get("location"), origin).pathname, `/${SLUG}/`, "Location");
    assert(new URL(r.headers.get("location"), origin).search.includes("host=app"), `Location ${r.headers.get("location")} lost the query`);
  });
  await check("page document carries X-Cast-Version", async () => {
    const r = await doc(null);
    assert(r.status === 200, `status ${r.status}`);
    const v = r.headers.get("x-cast-version");
    assert(/^\d+$/.test(v || ""), `X-Cast-Version ${v}`);
    return `v${v}`;
  });
  await check("host user agent: no bar, CSP adds allow-same-origin, never cached", async () => {
    const r = await doc(hostUa);
    const body = await r.text();
    eq(r.headers.get("content-security-policy"), HOST_CSP, "CSP");
    assert(!body.includes(BAR_MARKER), "the bar is in the host's page");
    assert(/no-store/.test(r.headers.get("cache-control") || ""), `Cache-Control ${r.headers.get("cache-control")}`);
  });
  await check("browser user agent: the bar, plain sandbox", async () => {
    const r = await doc("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15");
    const body = await r.text();
    const csp = r.headers.get("content-security-policy") || "";
    assert(csp.startsWith("sandbox ") && !csp.includes("allow-same-origin"), `CSP ${csp}`);
    assert(body.includes(BAR_MARKER), "no bar for a browser");
  });
  await check("a host user agent naming another slug is a browser", async () => {
    const r = await doc(hostUa.replace(`(${SLUG})`, "(someotherpage)"));
    assert(!(r.headers.get("content-security-policy") || "").includes("allow-same-origin"), "allow-same-origin for another slug's host");
  });
  if (KEY) {
    await check("without the key: the gate page, 403 Locked for ?app=1, 404 for ?icon", async () => {
      const page = await fetch(`${origin}/${SLUG}/?host=app`, { headers: { "User-Agent": hostUa } });
      eq(page.status, 200, "page status");
      const html = await page.text();
      assert(html.includes("codecast:gate") && !html.includes(BAR_MARKER), "not the gate page");
      eq(page.headers.get("cache-control"), "private, no-store", "gate page Cache-Control");
      const facts = await fetch(`${origin}/${SLUG}?app=1`);
      eq(facts.status, 403, "?app=1 status");
      eq(await facts.json(), { error: "Locked" }, "?app=1 body");
      eq((await fetch(`${origin}/${SLUG}?icon=512`)).status, 404, "?icon status");
      eq((await fetch(`${origin}/${SLUG}/tray.png`)).status, 200, "asset status (the gate page)");
    });
  }
  let facts = { icons: {} };
  await check("?app=1 answers AppInfo", async () => {
    const r = await fetch(`${origin}/${SLUG}?app=1${gateQs}`);
    assert(r.status === 200, `status ${r.status}`);
    assert(/no-store/.test(r.headers.get("cache-control") || ""), "facts are cached");
    const info = await r.json();
    for (const k of ["slug", "title", "version", "updated_at", "app", "owner", "icons", "relation", "policy"]) assert(k in info, `no ${k}`);
    eq(info.slug, SLUG, "slug");
    for (const k of ["name", "icon", "window", "tray", "permissions"]) assert(k in info.app, `app has no ${k}`);
    for (const k of ["width", "height", "minWidth", "minHeight", "resizable", "titleBar"]) assert(k in info.app.window, `window has no ${k}`);
    assert(["owner", "team", "other", "anonymous"].includes(info.relation), `relation ${info.relation}`);
    assert(typeof info.policy.install === "boolean" && typeof info.policy.fullAccess === "boolean", "policy");
    assert(!("gate" in info), "the HTTP answer carries gate keys");
    facts = info;
    return `v${info.version} ${info.relation} ${JSON.stringify(info.app.permissions)}`;
  });
  for (const size of [512, 1024]) {
    await check(`?icon=${size} is a PNG, through the URL ?app=1 names`, async () => {
      const url = facts.icons[String(size)];
      const hop = await fetch(url, { redirect: "manual" });
      const r = await fetch(url);
      assert(r.status === 200, `status ${r.status}`);
      assert(r.headers.get("x-content-type-options") === "nosniff", "no nosniff");
      const png = Buffer.from(await r.arrayBuffer());
      assert(png.subarray(1, 4).toString() === "PNG", "not a PNG");
      return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}${hop.status === 302 ? ` after a 302 from ${new URL(url).pathname}` : ""}`;
    });
  }
  if (!PROD) {
    await check("a page that declares no icon gets the generated monogram", async () => {
      const r = await fetch(`${origin}/${NOICON}?icon=1024`);
      eq(r.status, 200, "status");
      const png = Buffer.from(await r.arrayBuffer());
      assert(png.subarray(1, 4).toString() === "PNG", "not a PNG");
      eq([png.readUInt32BE(16), png.readUInt32BE(20)], [1024, 1024], "size");
      return "1024x1024 monogram";
    });
  }
  return facts;
}

// ── the shell stand-in: holds the apps bridge, records navigations ──
async function startShell() {
  return listen((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><title>Codecast (e2e shell)</title><body style="font:14px system-ui;padding:20px">e2e shell
<script>window.__navs = []; addEventListener("codecast-navigate", (e) => { __navs.push(e.detail); document.body.append(" → " + e.detail.path); });</script></body>`);
  });
}

// What the main-process inspector installs before anything is installed:
// records of what the Electron host does, and openExternal kept off the screen.
const MAIN_HOOKS = `(() => {
  const E = process.mainModule.require("electron");
  if (globalThis.__e2e) return "already";
  const rec = globalThis.__e2e = { notes: [], titles: [], tooltips: [], external: [], traysDestroyed: 0 };
  for (const [name, list] of [["setTitle", rec.titles], ["setToolTip", rec.tooltips]]) {
    const orig = E.Tray.prototype[name];
    E.Tray.prototype[name] = function (v, ...rest) { list.push(v); return orig.call(this, v, ...rest); };
  }
  const destroy = E.Tray.prototype.destroy;
  E.Tray.prototype.destroy = function () { rec.traysDestroyed++; return destroy.call(this); };
  E.shell.openExternal = async (url) => { rec.external.push(url); };
  return "hooked";
})()`;

/**
 * Records every call of main.js's showNativeNotification (both of its paths,
 * the native addon and Electron's Notification, start there) with a
 * breakpoint whose condition notes the call and never pauses.
 */
async function recordNotifications(main) {
  const source = fs.readFileSync(path.join(ELECTRON_DIR, "main.js"), "utf8").split("\n");
  const line = source.findIndex((l) => l.startsWith("function showNativeNotification("));
  assert(line >= 0, "main.js has no showNativeNotification");
  await main.send("Debugger.enable");
  const r = await main.send("Debugger.setBreakpointByUrl", {
    urlRegex: "packages/electron/main\\.js$",
    lineNumber: line + 1,
    condition: `(globalThis.__e2e.notes.push({ title: String(title), body: String(body) }), false)`,
  });
  assert(r.locations.length === 1, `the breakpoint resolved to ${r.locations.length} places`);
  return `notifications recorded at main.js:${line + 2}`;
}

// ── one host's pass ──
async function runHost(kind, standin) {
  currentHost = kind;
  const pageOrigin = PROD ? PAGE_ORIGIN : standin.origin;
  // The real path: /var is a symlink, and Launch Services and usernoted must see the path the shim runs from.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cc-apps-e2e-${kind}-`)));
  const userData = path.join(dir, "profile");
  const root = REAL_ROOT ? installer.defaultRoot() : path.join(dir, "Apps");
  const debugDir = path.join(dir, "shim");
  fs.mkdirSync(debugDir);
  const shimLog = path.join(debugDir, "shim.log");
  const shell = await startShell();
  const cdpPort = await freePort();
  const inspectPort = await freePort();
  const env = {
    ...process.env,
    CODECAST_USER_DATA: userData,
    CODECAST_URL: shell.origin,
    CODECAST_CDP_PORT: String(cdpPort),
    CODECAST_APPS_SHOW: "1",
    ...(PROD ? {} : { CODECAST_APPS_PAGE_ORIGIN: pageOrigin }),
    ...(kind === "electron" ? { CODECAST_APPS_HOST: "electron" } : { CODECAST_APPS_ROOT: root, CODECAST_APPS_HOST_BUNDLE_ID: "com.github.Electron" }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let child = null;
  let output = "";

  const sessions = [];
  const open = async (t) => {
    const s = await attach(t.webSocketDebuggerUrl);
    sessions.push(s);
    return s;
  };
  const targets = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).filter((t) => t.type === "page");
  const target = (what, pred, timeoutMs = 30_000) => until(what, async () => (await targets()).find(pred), timeoutMs);
  const bundleId = installer.bundleId(SLUG);
  let pageSince = Date.now();
  const shellApps = (expr) => shellPage.eval(`window.__CODECAST_ELECTRON__.apps.${expr}`);
  let shellPage;
  let main;
  let shimPid = null;
  let record;

  const lsInfo = () => {
    try {
      return execFileSync("lsappinfo", ["info", "-only", "name", "-only", "bundleid", "-only", "pid", "-only", "StatusLabel", bundleId], { encoding: "utf8" });
    } catch {
      return "";
    }
  };
  const pidOf = () => Number(/"pid"=(\d+)/.exec(lsInfo())?.[1]) || null;
  const badgeOf = () => /"StatusLabel"=\{ "label"="([^"]*)" \}/.exec(lsInfo())?.[1] ?? null;
  const logText = () => (fs.existsSync(shimLog) ? fs.readFileSync(shimLog, "utf8") : "");
  /** Signals the shim and waits for a log line after this moment. */
  const signalShim = async (sig, pattern, what, timeoutMs = 8000) => {
    const from = logText().length;
    process.kill(shimPid, sig);
    return until(what, () => pattern.exec(logText().slice(from)), timeoutMs);
  };
  /** The shim's snapshot (its window, tray page, status item), saved as <prefix>-<name>.png; resolves {files, delivered}. */
  const SNAPSHOT_FILES = ["window", "tray", "status-item", "window-frame", "screen-0", "screen-1"];
  const snapshot = async (prefix) => {
    for (const name of SNAPSHOT_FILES) fs.rmSync(path.join(debugDir, `${name}.png`), { force: true });
    const from = logText().length;
    process.kill(shimPid, "SIGUSR2");
    const delivered = (await until("the shim's delivered list", () => /delivered notifications \[([^\]]*)\]/.exec(logText().slice(from)), 8000))[1];
    await until("the window snapshot", () => /snapshot window\n/.test(logText().slice(from)), 8000);
    await sleep(400);
    const saved = {};
    for (const name of SNAPSHOT_FILES) {
      const f = path.join(debugDir, `${name}.png`);
      if (fs.existsSync(f)) saved[name] = shot(`${prefix}-${name}.png`, fs.readFileSync(f));
    }
    return { files: saved, delivered };
  };
  /** Where the host's own Electron-side evidence lives. */
  const mainRec = () => main.eval("JSON.parse(JSON.stringify(globalThis.__e2e))");
  /** Every native notification Codecast's main process showed (showNativeNotification, recorded by recordNotifications). */
  const shownNotes = async () => (await mainRec()).notes;
  const probes = standin && standin.probes;
  const windowPage = (opts) => probes.waitFor((c) => c.slug === SLUG && c.surface === "window", { what: "the app window's page", ...opts });
  const run = (client, code, ms) => probes.run(client, code, ms);
  /** Starts Codecast from source (again), attaches to its main window and its main process, and hooks the recorders. */
  async function boot(args = []) {
    child = spawn(electronBin, [ELECTRON_DIR, "--background", `--inspect=${inspectPort}`, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    shellPage = await open(await target("the main window", (t) => t.url.startsWith(`${shell.origin}/inbox`), 60_000));
    await until("the shell bridge", () => shellPage.eval("typeof window.__CODECAST_ELECTRON__?.apps?.install === 'function'"));
    const mt = await until("the main process inspector", async () => (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0]);
    main = await attach(mt.webSocketDebuggerUrl);
    sessions.push(main);
    return `${await main.eval(MAIN_HOOKS)}, ${await recordNotifications(main)}`;
  }
  /** Stops Codecast; resolves how it went ("SIGTERM in 600 ms", or "SIGKILL after ..."). */
  async function quit() {
    if (!child || child.exitCode !== null || child.signalCode) return "not running";
    // Node holds the process at exit while an inspector session is attached.
    for (const s of sessions.splice(0)) s.close();
    const started = Date.now();
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(8000)]);
    if (child.exitCode === null && !child.signalCode) {
      child.kill("SIGKILL");
      await exited;
      return `SIGKILL after ${Date.now() - started} ms`;
    }
    return `SIGTERM in ${Date.now() - started} ms`;
  }
  const notifyLines = (tag) => logText().split("\n").filter((l) => l === `[appshim] notify ${tag}`);

  try {
    // A real install of the same page shares its bundle id, and so its data, with the one made here.
    if (kind === "mac" && installer.listBundles().some((b) => b.info.CodecastAppSlug === SLUG)) {
      throw new Error(`${SLUG} is installed in ~/Applications/Codecast Apps; this run would share and then remove its data`);
    }
    // ── boot ──
    await check("main.js boots from source with its own profile", async () => {
      const hooks = await boot();
      eq(await shellApps("list()"), [], "apps.list()");
      return hooks;
    });

    // ── install ──
    const facts = await check("the page's facts for the install", async () => {
      const r = await fetch(`${pageOrigin}/${SLUG}?app=1${gateQs}`);
      assert(r.ok, `?app=1 answered ${r.status}`);
      return r.json();
    });
    if (!PROD) {
      await check("a page whose team turned installs off is refused before any sheet", async () => {
        const blocked = await (await fetch(`${pageOrigin}/${BLOCKED}?app=1`)).json();
        eq(blocked.policy.install, false, "policy.install");
        const sheetsBefore = (await targets()).filter((t) => t.url.includes("/apps/consent/")).length;
        const answer = await shellPage.eval(`window.__CODECAST_ELECTRON__.apps.install(${JSON.stringify({ ...blocked, gate: {} })}).then((r) => r, (e) => ({ error: e.message }))`);
        assert(/your team does not allow installing apps/.test(answer && answer.error), `apps.install() answered ${JSON.stringify(answer)}`);
        await sleep(500);
        eq((await targets()).filter((t) => t.url.includes("/apps/consent/")).length, sheetsBefore, "consent sheets");
        eq(await shellApps("list()"), [], "apps.list()");
        const settingsFile = path.join(userData, "settings.json");
        const saved = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")).installedApps || {} : {};
        assert(!saved[BLOCKED], "a registry row for the refused page");
        if (kind === "mac") assert(!installer.listBundles(root).some((b) => b.info.CodecastAppSlug === BLOCKED), "a bundle for the refused page");
        return answer.error;
      });
    }
    const info = { ...facts, gate: KEY ? { k: KEY } : {} };
    const asked = facts.app.permissions;
    let sheetId;
    await check("apps.install opens the install sheet with the page's permissions", async () => {
      await shellPage.eval(`window.__install = window.__CODECAST_ELECTRON__.apps.install(${JSON.stringify(info)}).catch((e) => ({ error: e.message })); true`);
      const sheet = await open(await target("the install sheet", (t) => t.url.startsWith(`${shell.origin}/apps/consent/`)));
      await until("the sheet bridge", () => sheet.eval("!!window.__CODECAST_ELECTRON__?.apps"));
      sheetId = decodeURIComponent((await sheet.eval("location.pathname")).split("/apps/consent/")[1]);
      const req = await sheet.eval(`window.__CODECAST_ELECTRON__.apps.consent.get(${JSON.stringify(sheetId)})`);
      eq(req.kind, "install", "kind");
      eq(req.asked, asked, "asked");
      eq(req.info.slug, SLUG, "slug");
      // The sheet closes once answered, so the answer's own reply may never come back.
      await sheet.answerConsent(sheetId, { approve: true, grants: asked });
      eq(await until("the install to finish", () => shellPage.eval("window.__install"), 60_000), { installed: true, slug: SLUG }, "apps.install()");
      return `consent ${sheetId}`;
    });
    await check("the registry row: name, grants for this version, sealed gate key, icon", async () => {
      const settings = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
      record = settings.installedApps[SLUG];
      assert(record, "no record");
      eq(record.name, facts.app.name, "name");
      eq(record.grantedVersion, facts.version, "grantedVersion");
      eq(record.grants, asked, "grants");
      if (KEY) assert(!JSON.stringify(record.gate).includes(KEY), "the gate key is stored in the clear");
      assert(record.iconPath && fs.existsSync(record.iconPath), "no icon file");
      if (kind === "mac") assert(record.bundlePath && record.bundlePath.startsWith(root + path.sep), `bundle outside the test root: ${record.bundlePath}`);
    });

    // ── the app is up ──
    if (kind === "mac") {
      await check("the bundle is in the test root, sealed, with the contract's Info.plist", async () => {
        if (!REAL_ROOT) assert(!installer.listBundles().some((b) => b.info.CodecastAppSlug === SLUG), "a bundle landed in ~/Applications/Codecast Apps");
        else assert(path.basename(record.bundlePath).startsWith("E2E "), `a bundle in the real root not named E2E: ${record.bundlePath}`);
        const plist = installer.readInfo(record.bundlePath);
        eq(plist.CFBundleIdentifier, bundleId, "bundle id");
        eq(plist.CodecastAppSlug, SLUG, "slug");
        eq(plist.CodecastHostBundleId, "com.github.Electron", "host bundle id");
        assert(plist.CodecastPageUrl === `${pageOrigin}/${SLUG}?host=app${gateQs}`, `page URL ${plist.CodecastPageUrl}`);
        eq([plist.CodecastWindowWidth, plist.CodecastWindowHeight, plist.CodecastMinWidth, plist.CodecastMinHeight], [facts.app.window.width, facts.app.window.height, facts.app.window.minWidth, facts.app.window.minHeight], "window keys");
        assert(fs.existsSync(path.join(record.bundlePath, "Contents/Resources/client.js")), "no client.js");
        execFileSync("codesign", ["--verify", "--deep", "--strict", record.bundlePath], { stdio: "pipe" });
        return path.basename(record.bundlePath);
      });
      await check("Codecast launched it: lsappinfo shows its own name and bundle id", async () => {
        const out = await until("the shim to run", () => (pidOf() ? lsInfo() : null), 20_000);
        assert(out.includes(`"LSDisplayName"="${facts.app.name}"`), out);
        assert(out.includes(`"CFBundleIdentifier"="${bundleId}"`), out);
        shimPid = pidOf();
        return `pid ${shimPid}`;
      });
      // Relaunch it with the shim's debug aid on, to read its log and take its snapshots.
      process.kill(shimPid, "SIGTERM");
      await until("the first launch to quit", () => !pidOf(), 10_000);
      pageSince = Date.now();
      execFileSync("open", ["-n", "-g", "--env", `CODECAST_APPSHIM_DEBUG_DIR=${debugDir}`, "--stderr", shimLog, record.bundlePath]);
      shimPid = await until("the debug launch", () => pidOf(), 20_000);
    } else {
      await check("the app window loads the page in its own partition", async () => {
        const t = await target("the app window", (t) => isPageUrl(t.url, pageOrigin, "window") && (!KEY || new URL(t.url).searchParams.get("k") === KEY));
        const partition = path.join(userData, "Partitions", `app-${SLUG}`);
        await until("the partition on disk", () => fs.existsSync(partition), 10_000);
        return t.url.replace(pageOrigin, "");
      });
    }
    if (PROD) {
      skip("page checks", "--prod: no probe in the real page, no control over its data or versions");
    } else {
      const win = await windowPage({ since: pageSince });
      await check("cast.app.info() reports the app, its version and grants", async () => {
        const i = await run(win, "return cast.app.info()");
        eq([i.slug, i.name, i.version, i.surface, i.grants, i.requested], [SLUG, facts.app.name, facts.version, "window", asked, asked], "info");
        if (kind === "mac") {
          assert(["not-determined", "denied", "authorized", "provisional", "ephemeral"].includes(i.notifications), `notifications ${i.notifications}`);
          eq(i.notificationSettingsUrl, `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`, "notificationSettingsUrl");
          return `notifications ${i.notifications}`;
        }
      });
      await check("served as a host: user agent suffix, no bar, working localStorage", async () => {
        const r = await run(win, `localStorage.setItem("e2e", "1");
          return { ua: navigator.userAgent, bar: !!document.getElementById("__cc_bar"), ls: localStorage.getItem("e2e") }`);
        const m = HOST_UA_RE.exec(r.ua);
        assert(m && m[2] === SLUG, `user agent ${r.ua}`);
        eq([r.bar, r.ls], [false, "1"], "[bar, localStorage]");
        const load = standin.loads.filter((l) => l.slug === SLUG).at(-1);
        assert(load && load.host, "the document request did not carry the host user agent");
        return m[0].trim();
      });
      await check("the page's count reaches the Dock badge and the menu bar title", async () => {
        if (kind === "mac") {
          await until("the Dock badge 3", () => badgeOf() === "3", 15_000);
          await until("the menu bar title 3", () => /\[appshim\] tray title "3"/.test(logText()), 15_000);
          return "badge 3, title 3";
        }
        await until("the tray title 3", async () => (await mainRec()).titles.includes("3"), 15_000);
        return "title 3 (the Electron host's badge is a Windows taskbar overlay)";
      });

      // ── a new item: exactly one notification ──
      await check(kind === "mac" ? "a new waiting item: the shim asks macOS for exactly one notification" : "a new waiting item: main asks the OS for exactly one notification", async () => {
        const rows = standin.state(SLUG).data.waiting.rows;
        const notesBefore = kind === "electron" ? (await shownNotes()).length : 0;
        standin.setRows(SLUG, "waiting", [["decision", "sd-9999", "Approve the e2e harness?", "installed apps", new Date().toISOString(), "https://codecast.sh/decisions/sd-9999"], ...rows]);
        let detail;
        if (kind === "mac") {
          await until("the shim to ask for a notification", () => notifyLines("decision:sd-9999").length > 0, 15_000);
          await sleep(3000);
          eq(notifyLines("decision:sd-9999").length, 1, "notifications for the new item");
          const all = logText().split("\n").filter((l) => /^\[appshim\] notify [^ ]+$/.test(l));
          eq(all.length, 1, "notifications in all");
          const outcome = await until("the notification's outcome", () => /\[appshim\] notify decision:sd-9999 (posted|denied: .*|failed: .*)/.exec(logText())?.[1], 6000).catch(() => "pending (macOS is asking the person)");
          detail = `notification ${outcome}`;
          await until("the Dock badge 4", () => badgeOf() === "4", 10_000);
        } else {
          await until("the host to notify", async () => (await shownNotes()).length > notesBefore, 15_000).catch(async (err) => {
            const probe = await run(win, "return cast.app.notify({ title: 'probe', body: 'probe', tag: 'probe' }).then(() => 'ok', (e) => e.code + ': ' + e.message)").catch((e) => e.message);
            throw new Error(`${err.message}; recorded ${JSON.stringify((await mainRec()).notes)}; a notify from the page answers ${probe}`);
          });
          await sleep(3000);
          const notes = (await shownNotes()).slice(notesBefore);
          eq(notes.map((n) => n.body), ["Approve the e2e harness?"], "notifications");
          detail = `"${notes[0].title}" shown by main`;
          await until("the tray title 4", async () => (await mainRec()).titles.at(-1) === "4", 10_000);
        }
        return detail;
      });
      // Asking is not delivering. macOS delivers only for a bundle it validates
      // (one in an Applications folder, so --real-root) that a person allowed to
      // notify, and only a delivered notification can be clicked.
      if (kind === "mac" && !REAL_ROOT) {
        blocked("macOS delivered it (UNUserNotificationCenter) and its click opens the item", `macOS validates notification clients only in an Applications folder (usernoted: "Failed to find or validate client" for the temp root; the shim says ${/\[appshim\] notify decision:sd-9999 (posted|denied: .*|failed: .*)/.exec(logText())?.[1] ?? "nothing yet"}); rerun with --real-root --await-grant 5 and allow notifications for "E2E Needs you" while it waits`);
      } else if (kind === "mac") {
        await check("macOS delivered it (UNUserNotificationCenter)", async () => {
          await until("macOS's answer", () => /\[appshim\] notify decision:sd-9999 (posted|denied|failed)/.test(logText()), 10_000).catch(() => {});
          let outcome = /\[appshim\] notify decision:sd-9999 (posted|denied: .*|failed: .*)/.exec(logText())?.[1];
          let tag = "decision:sd-9999";
          const rowsBefore = standin.state(SLUG).data.waiting.rows;
          for (let n = 1, until_ = Date.now() + AWAIT_GRANT_MS; outcome !== "posted" && Date.now() < until_; n++) {
            if (n === 1) say(`waiting up to ${AWAIT_GRANT_MS / 60_000} min: allow notifications for "${facts.app.name}" in System Settings > Notifications`);
            await sleep(15_000);
            const ref = `sd-e2e${n}`;
            tag = `decision:${ref}`;
            standin.setRows(SLUG, "waiting", [["decision", ref, `Grant check ${n}`, "installed apps", new Date().toISOString(), `https://codecast.sh/decisions/${ref}`], ...standin.state(SLUG).data.waiting.rows]);
            outcome = await until("macOS's answer", () => new RegExp(`\\[appshim\\] notify ${tag} (posted|denied: .*|failed: .*)`).exec(logText())?.[1], 10_000).catch(() => undefined);
          }
          if (standin.state(SLUG).data.waiting.rows !== rowsBefore) {
            // The re-asks' items go again, so the count the later checks expect holds.
            standin.setRows(SLUG, "waiting", rowsBefore);
            await until("the Dock badge back at 4", () => badgeOf() === "4", 90_000).catch(() => {});
          }
          if (outcome !== "posted") throw new Error(`${outcome ?? "no answer from macOS (its permission prompt is waiting)"}: allow notifications for "${facts.app.name}" (${bundleId}) in System Settings > Notifications, then rerun with --real-root --await-grant 5`);
          const { delivered } = await snapshot("mac-notified");
          assert(delivered.includes(tag), `posted but not in the delivered list [${delivered}]`);
          return `delivered [${delivered}]`;
        }, { soft: true });
        blocked("its click opens the item", "a click on a Notification Center banner needs a person or a Screen Recording and Accessibility grant for this terminal");
      } else {
        blocked("the OS showed it", "from source on a Mac the Electron path posts as Electron.app, which has no notification grant; the shipped Electron host is Windows, whose toasts (AUMID) are checked only there");
      }
      skip("notification banner screenshot", "screencapture needs Screen Recording for this terminal (\"could not create image from rect\"); the banner is drawn by Notification Center, outside the app's own windows");

      // ── the tray popover ──
      await check("the tray popover opens the page at surface=tray", async () => {
        const since = Date.now();
        const eventsBefore = probes.events.length;
        if (kind === "mac") process.kill(shimPid, "SIGUSR1");
        else await shellApps(`open(${JSON.stringify(SLUG)}, { surface: "tray" })`);
        const tray = await probes.waitFor((c) => c.slug === SLUG && c.surface === "tray", { since, what: "the tray page" });
        const i = await run(tray, "return cast.app.info()");
        eq(i.surface, "tray", "surface");
        await until("the tray-click event", () => probes.events.slice(eventsBefore).some((e) => e.event === "tray-click"), 5000);
        // The window holds the notifier lock, so the popover only paints.
        await run(tray, "await new Promise((r) => setTimeout(r, 1500)); return document.getElementById('count').textContent").then((n) => eq(n, "4", "the popover's count"));
        let file;
        if (kind === "mac") {
          await sleep(800);
          file = (await snapshot("mac")).files.tray;
        } else {
          const tt = await target("the tray window", (t) => isPageUrl(t.url, pageOrigin, "tray"));
          file = shot("electron-tray.png", await (await open(tt)).screenshot());
        }
        if (kind === "mac") process.kill(shimPid, "SIGUSR1");
        return file;
      });
      await check("opening an item routes it to Codecast's main window", async () => {
        await run(win, "document.querySelector('.item[data-key=\"decision:sd-9999\"]').click(); return true");
        const navs = await until("the main window's navigation", async () => {
          const n = await shellPage.eval("window.__navs");
          return n.length ? n : null;
        }, 10_000).catch(async (err) => {
          const direct = await run(win, "return cast.app.openInCodecast('/tasks/ct-1').then(() => 'ok', (e) => e.code + ': ' + e.message)").catch((e) => e.message);
          const ext = kind === "electron" ? JSON.stringify((await mainRec()).external) : "";
          const shellUrl = await shellPage.eval("location.href");
          throw new Error(`${err.message}; openInCodecast answers ${direct}; external ${ext}; shell at ${shellUrl}; navs ${JSON.stringify(await shellPage.eval("window.__navs"))}`);
        });
        eq(navs.at(-1).path, "/decisions/sd-9999", "path");
        return navs.at(-1).path;
      });
      if (kind === "mac") {
        await check("the app's menu: Show in Codecast and Settings… reach this Codecast", async () => {
          const pick = async (title, pattern, what) => {
            fs.writeFileSync(path.join(debugDir, "pick.txt"), title);
            return signalShim("SIGINFO", pattern, what);
          };
          const before = (await shellPage.eval("window.__navs")).length;
          await pick("Show in Codecast", /pick Show in Codecast/, "the menu pick");
          const navs = await until("the main window's navigation", async () => {
            const n = await shellPage.eval("window.__navs");
            return n.length > before ? n : null;
          }, 10_000);
          eq(navs.at(-1).path, "/pages", "Show in Codecast");
          const settings = await pick("Settings", /would open (\S+) in (.+)\n/, "the Settings link");
          eq(settings[1], `codecast://open/settings/installed-apps?app=${SLUG}`, "the Settings link");
          assert(/\/Electron\.app$/.test(settings[2]) && !settings[2].startsWith("/Applications/Codecast.app"), `the Settings link opens in ${settings[2]}`);
          return `/pages; ${settings[1]} in ${path.basename(settings[2])}`;
        });
      }
      await check("navigation stays on the page's path", async () => {
        if (kind === "mac") {
          await run(win, "location.href = 'ssh://example.invalid'; await new Promise((r) => setTimeout(r, 600)); return location.pathname").then((p) => assert(PAGE_PATHS.includes(p), `path ${p}`));
          assert(/refused to open ssh:\/\/example\.invalid/.test(logText()), "the shim did not refuse ssh://");
          return "ssh:// refused";
        }
        const before = (await mainRec()).external.length;
        await run(win, `location.href = ${JSON.stringify(`${pageOrigin}/elsewhere`)}; await new Promise((r) => setTimeout(r, 600)); return location.pathname`).then((p) => assert(PAGE_PATHS.includes(p), `path ${p}`));
        eq((await mainRec()).external.slice(before), [`${pageOrigin}/elsewhere`], "handed to the default browser");
        return "off-path page handed to the default browser";
      });
      await check("screenshot of the app window", async () => {
        if (kind === "mac") return (await snapshot("mac")).files.window;
        const t = await target("the app window", (t) => isPageUrl(t.url, pageOrigin, "window"));
        return shot("electron-window.png", await (await open(t)).screenshot());
      });

      // ── a second app beside it: Standup (overlay, a shortcut the page registers itself) ──
      await check("a second app installs beside it with its own storage", async () => {
        const slug2 = "e2estandup";
        const facts2 = await (await fetch(`${pageOrigin}/${slug2}?app=1`)).json();
        const since = Date.now();
        await shellPage.eval(`window.__install2 = window.__CODECAST_ELECTRON__.apps.install(${JSON.stringify({ ...facts2, gate: {} })}).catch((e) => ({ error: e.message })); true`);
        const sheetT = await target("the second install sheet", (t) => t.url.startsWith(`${shell.origin}/apps/consent/`));
        const sheet = await open(sheetT);
        await until("the sheet bridge", () => sheet.eval("!!window.__CODECAST_ELECTRON__?.apps"));
        const id2 = decodeURIComponent(sheetT.url.split("/apps/consent/")[1]);
        await sheet.answerConsent(id2, { approve: true, grants: facts2.app.permissions });
        eq(await until("the second install", () => shellPage.eval("window.__install2"), 60_000), { installed: true, slug: slug2 }, "apps.install()");
        const page = await probes.waitFor((c) => c.slug === slug2 && c.surface === "window", { since, what: "Standup's page" });
        const i = await run(page, "return cast.app.info()");
        eq([i.slug, i.name, i.grants], [slug2, facts2.app.name, facts2.app.permissions], "Standup's info");
        // Both pages share the stand-in's origin, as every page shares a.codecast.sh: only the install keeps them apart.
        eq(await run(page, "return Object.keys(localStorage).filter((k) => k.startsWith('needs-you') || k === 'e2e')"), [], "Needs you's keys seen from Standup");
        // The page registers CmdOrCtrl+Shift+U itself once shortcuts is granted, and shows its keys when it took.
        await run(page, "for (let i = 0; i < 50 && document.getElementById('add-key'); i++) await new Promise((r) => setTimeout(r, 100)); return !document.getElementById('add-key')").then((v) => assert(v, "Standup's shortcut did not register"));
        if (kind === "electron") assert(await main.eval(`process.mainModule.require("electron").globalShortcut.isRegistered("CmdOrCtrl+Shift+U")`), "CmdOrCtrl+Shift+U is not registered with Electron");
        // Pin: overlay keeps it on top at 360 wide.
        const pinned = await run(page, "document.getElementById('pin').click(); for (let i = 0; i < 30 && document.getElementById('pin').getAttribute('aria-pressed') !== 'true'; i++) await new Promise((r) => setTimeout(r, 100)); await new Promise((r) => setTimeout(r, 300)); return [document.getElementById('pin').textContent.trim(), innerWidth]");
        eq(pinned, ["Pinned", 360], "[pin, width]");
        if (kind === "electron") {
          const onTop = await main.eval(`process.mainModule.require("electron").BrowserWindow.getAllWindows().filter((w) => ["/${slug2}?", "/${slug2}/?"].some((p) => w.webContents.getURL().includes(p))).map((w) => w.isAlwaysOnTop())`);
          eq(onTop, [true], "Standup's window is always on top");
        }
        // The first app still answers as itself.
        eq((await run(win, "return cast.app.info()")).slug, SLUG, "Needs you's info after Standup installed");
        eq(await shellApps(`uninstall(${JSON.stringify(slug2)})`), true, "uninstall Standup");
        if (kind === "mac") await until("Standup's shim to quit", () => !execFileSync("lsappinfo", ["info", "-only", "pid", installer.bundleId(slug2)], { encoding: "utf8" }).includes("pid"), 10_000);
        else assert(!(await main.eval(`process.mainModule.require("electron").globalShortcut.isRegistered("CmdOrCtrl+Shift+U")`)), "Standup's shortcut outlived it");
        eq((await shellApps("list()")).map((a) => a.slug), [SLUG], "apps left");
        eq((await run(win, "return cast.app.info()")).grants, asked, "Needs you's grants after Standup left");
        return `${facts2.app.name}: ${JSON.stringify(i.grants)}, shortcut, pinned`;
      });

      // ── republish: version event, reload, re-ask for the new permission ──
      let page2;
      let reviewId;
      await check("a republish reloads the app at the new version", async () => {
        const since = Date.now();
        const eventsBefore = probes.events.length;
        const { version } = standin.republish(SLUG, "shortcuts");
        const next = await (await fetch(`${pageOrigin}/${SLUG}?app=1${gateQs}`)).json();
        await shellPage.eval(`window.__CODECAST_ELECTRON__.apps.facts(${JSON.stringify(SLUG)}, ${JSON.stringify(next)}); true`);
        await until("the version event", () => probes.events.slice(eventsBefore).some((e) => e.event === "version" && e.data.version === version), 10_000);
        page2 = await windowPage({ since, what: "the reloaded page" });
        eq(page2.version, version, "the reloaded document's version");
        eq((await run(page2, "return cast.app.info()")).version, version, "info().version");
        return `v${version}`;
      });
      await check("until the review is answered every permission needs consent", async () => {
        const sheet = await open(await target("the review sheet", (t) => t.url.startsWith(`${shell.origin}/apps/consent/`) && !t.url.endsWith(encodeURIComponent(sheetId))));
        await until("the review sheet bridge", () => sheet.eval("!!window.__CODECAST_ELECTRON__?.apps"));
        reviewId = decodeURIComponent((await sheet.eval("location.pathname")).split("/apps/consent/")[1]);
        const req = await sheet.eval(`window.__CODECAST_ELECTRON__.apps.consent.get(${JSON.stringify(reviewId)})`);
        eq([req.kind, req.added], ["review", ["shortcuts"]], "[kind, added]");
        const codes = await run(page2, `const code = (p) => p.then(() => "ok", (e) => e.code);
          return [await code(cast.app.notify({ title: "x", body: "y", tag: "stale" })), await code(cast.app.shortcuts.register("CmdOrCtrl+Alt+Shift+F19")), await code(cast.app.badge(1))]`);
        eq(codes, ["needs-consent", "needs-consent", "ok"], "[notify, shortcuts.register, badge]");
        assert((await shellApps("list()"))[0].needsReview === true, "apps.list() shows no review");
        await sheet.answerConsent(reviewId, { approve: true, grants: [...asked, "shortcuts"] });
        await until("grants for the new version", async () => (await shellApps("list()"))[0].grantedVersion === page2.version, 10_000);
        return JSON.stringify(req.asked);
      });
      await check("approved, a global shortcut registers", async () => {
        const r = await run(page2, `const code = (p) => p.then(() => "ok", (e) => e.code + ": " + e.message);
          return [await code(cast.app.shortcuts.register("CmdOrCtrl+Alt+Shift+F19")), await code(cast.app.shortcuts.register("CmdOrCtrl+Shift+Banana")), (await cast.app.info()).grants]`);
        eq(r[0], "ok", "register");
        assert(/^(bad-args|failed)/.test(r[1]), `a bad accelerator: ${r[1]}`);
        eq(r[2], [...asked, "shortcuts"], "grants");
        if (kind === "electron") assert(await main.eval(`process.mainModule.require("electron").globalShortcut.isRegistered("CmdOrCtrl+Alt+Shift+F19")`), "not registered with Electron");
        return "CmdOrCtrl+Alt+Shift+F19";
      });
      await check("a page newer than the facts is refused until they confirm it; nothing new still re-asks", async () => {
        // The server has v+1 before the facts feed says so: a reload shows the new document, which the host must not trust yet.
        const { version } = standin.republish(SLUG);
        let since = Date.now();
        await run(page2, "setTimeout(() => location.reload(), 50); return true");
        const ahead = await windowPage({ since, what: "the page reloaded ahead of the facts" });
        eq(ahead.version, version, "the document's version");
        const codes = await run(ahead, `const code = (p) => p.then(() => "ok", (e) => e.code);
          return [await code(cast.app.notify({ title: "x", body: "y", tag: "ahead" })), await code(cast.app.permissions.request(["notifications"])), (await cast.app.info()).grants]`);
        eq(codes, ["mixed-version", "mixed-version", []], "[notify, permissions.request, info().grants]");
        // The facts confirm it: the host reloads and re-asks, though the version asks for nothing new.
        since = Date.now();
        const next = await (await fetch(`${pageOrigin}/${SLUG}?app=1${gateQs}`)).json();
        await shellPage.eval(`window.__CODECAST_ELECTRON__.apps.facts(${JSON.stringify(SLUG)}, ${JSON.stringify(next)}); true`);
        const sheetT = await target("the one-tap re-ask", (t) => t.url.startsWith(`${shell.origin}/apps/consent/`) && !t.url.endsWith(encodeURIComponent(reviewId)));
        const sheet = await open(sheetT);
        await until("the re-ask bridge", () => sheet.eval("!!window.__CODECAST_ELECTRON__?.apps"));
        const id = decodeURIComponent(sheetT.url.split("/apps/consent/")[1]);
        const req = await sheet.eval(`window.__CODECAST_ELECTRON__.apps.consent.get(${JSON.stringify(id)})`);
        eq([req.kind, req.added], ["review", []], "[kind, added]");
        await sheet.answerConsent(id, { approve: true, grants: req.current });
        await until("grants for the confirmed version", async () => (await shellApps("list()"))[0].grantedVersion === version, 10_000);
        page2 = await windowPage({ since, what: "the confirmed page" });
        // Past the engine, the answer is the OS's: on a Mac "denied" until a person allows this app to notify.
        const confirmed = await run(page2, `return cast.app.notify({ title: "Confirmed", body: "v${version}", tag: "confirmed", silent: true }).then(() => "ok", (e) => e.code)`);
        assert((kind === "mac" ? ["ok", "denied"] : ["ok"]).includes(confirmed), `notify at the confirmed version answered ${confirmed}`);
        return `v${version}: mixed-version, then one-tap re-ask`;
      });
    }

    if (!PROD) {
      // ── Codecast restarts while the app is open ──
      await check("Codecast restarts: the app comes back with its version and grants", async () => {
        const eventsBefore = probes.events.length;
        const since = Date.now();
        const quitHow = await quit();
        say(`quit: ${quitHow}`);
        if (kind === "mac") {
          // The shim covers the page once Codecast is gone for a while, and must not start any Codecast itself.
          await until("the shim's not-running cover", () => /host state notRunning/.test(logText()), 15_000);
          assert(!/launching /.test(logText()), "the shim launched a Codecast");
          await boot();
          await until("the shim to reconnect and hear its grants", () => probes.events.slice(eventsBefore).some((e) => e.slug === SLUG && e.event === "grants"), 20_000);
          const i = await run(await windowPage({ what: "the app's page" }), "return cast.app.info()");
          eq([i.version, i.grants], [standin.state(SLUG).version, [...asked, "shortcuts"]], "[version, grants]");
          await until("the cover to go", () => /host state ready/.test(logText().slice(logText().lastIndexOf("host state notRunning"))), 10_000);
          return "reconnected, grants event, cover gone";
        }
        // Electron: the app's windows went with Codecast; a shortcut launch (--codecast-app) opens it again.
        await boot([`--codecast-app=${SLUG}`]);
        const again = await windowPage({ since, what: "the app after the restart" });
        const i = await run(again, "return cast.app.info()");
        eq([i.version, i.grants], [standin.state(SLUG).version, [...asked, "shortcuts"]], "[version, grants]");
        return "reopened by --codecast-app";
      });
      await check("signed out, the app covers its page; signed in, the page is back", async () => {
        const since = Date.now();
        await shellApps("setSignedIn(false)");
        if (kind === "mac") {
          await until("the signed-out cover", () => /host state signedOut/.test(logText()), 10_000);
        } else {
          const cover = await open(await target("the signed-out cover", (t) => t.url.startsWith("data:text/html")));
          const text = await until("the cover's text", () => cover.eval("document.body?.innerText"));
          assert(/Codecast is signed out/.test(text), text);
        }
        eq(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).installedAppsSignedIn, false, "installedAppsSignedIn");
        await shellApps("setSignedIn(true)");
        if (kind === "mac") await until("the cover to go", () => /host state ready/.test(logText().slice(logText().lastIndexOf("host state signedOut"))), 10_000);
        else await windowPage({ since, what: "the page after signing in" });
        return "covered and uncovered";
      });
    }

    // ── uninstall ──
    await check("uninstall removes the app, its data and its record", async () => {
      eq(await shellApps(`uninstall(${JSON.stringify(SLUG)})`), true, "apps.uninstall()");
      eq(await shellApps("list()"), [], "apps.list()");
      eq(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).installedApps, {}, "installedApps");
      assert(!fs.existsSync(path.join(userData, "apps", SLUG)), "the icon folder is still there");
      if (kind === "mac") {
        await until("the shim to quit", () => !pidOf(), 10_000);
        shimPid = null;
        assert(!fs.existsSync(record.bundlePath), "the bundle is still there");
        const dump = execFileSync(installer.LSREGISTER, ["-dump"], { maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" });
        assert(!dump.includes(record.bundlePath), "Launch Services still has the bundle");
        await sleep(3500); // the second sweep, once the process is gone
        const left = installer.dataPaths(SLUG).filter((p) => fs.existsSync(p));
        eq(left, [], "app data left behind");
        return "bundle, LS record, data, record";
      }
      await until("the app window to close", async () => !(await targets()).some((t) => t.url.startsWith(`${pageOrigin}/${SLUG}`)), 10_000);
      const rec = await mainRec();
      assert(rec.traysDestroyed >= 1, "the tray item was not destroyed");
      if (!PROD) assert(!(await main.eval(`process.mainModule.require("electron").globalShortcut.isRegistered("CmdOrCtrl+Alt+Shift+F19")`)), "the shortcut is still registered");
      if (!PROD) {
        // The page's origin, read back in the app's partition through a document with no sandbox.
        const keys = await main.eval(`(async () => {
          const E = process.mainModule.require("electron");
          const w = new E.BrowserWindow({ show: false, webPreferences: { partition: "persist:app-${SLUG}" } });
          await w.loadURL(${JSON.stringify(`${pageOrigin}/__e2e/blank`)}).catch(() => {});
          const keys = await w.webContents.executeJavaScript("Object.keys(localStorage)");
          w.destroy();
          return keys;
        })()`);
        eq(keys, [], "the partition's localStorage after uninstall");
      }
      return "window, tray, shortcut, partition storage, record";
    });
    if (!PROD) {
      await check("the same page installs again after the uninstall", async () => {
        const since = Date.now();
        const now = await (await fetch(`${pageOrigin}/${SLUG}?app=1${gateQs}`)).json();
        await shellPage.eval(`window.__install3 = window.__CODECAST_ELECTRON__.apps.install(${JSON.stringify({ ...now, gate: { k: KEY } })}).catch((e) => ({ error: e.message })); true`);
        const sheetT = await target("the install sheet", (t) => t.url.startsWith(`${shell.origin}/apps/consent/`));
        const sheet = await open(sheetT);
        await until("the sheet bridge", () => sheet.eval("!!window.__CODECAST_ELECTRON__?.apps"));
        const id3 = decodeURIComponent(sheetT.url.split("/apps/consent/")[1]);
        const req = await sheet.eval(`window.__CODECAST_ELECTRON__.apps.consent.get(${JSON.stringify(id3)})`);
        eq([req.kind, req.current], ["install", []], "a fresh install asks from nothing");
        await sheet.answerConsent(id3, { approve: true, grants: ["notifications"] });
        eq(await until("the install", () => shellPage.eval("window.__install3"), 60_000), { installed: true, slug: SLUG }, "apps.install()");
        const page = await windowPage({ since, what: "the reinstalled page" });
        const i = await run(page, "return cast.app.info()");
        eq([i.version, i.grants], [now.version, ["notifications"]], "[version, grants]");
        // A new install starts from empty storage: the old install's "seen" list is gone.
        eq(await run(page, "return localStorage.getItem('e2e')"), null, "the old install's storage");
        eq(await shellApps(`uninstall(${JSON.stringify(SLUG)})`), true, "apps.uninstall()");
        if (kind === "mac") await until("the shim to quit", () => !pidOf(), 10_000);
        eq(await shellApps("list()"), [], "apps.list()");
        return `v${i.version}, grants ${JSON.stringify(i.grants)}`;
      });
    }
  } catch (err) {
    // A failed check is already recorded and ends the pass here; anything else is a failure too.
    const last = results.at(-1);
    if (!last || last.host !== kind || last.status !== "fail" || last.detail !== err.message) {
      results.push({ host: kind, name: "the pass ran to its end", status: "fail", detail: err.message });
      say(`FAIL  ${err.message}`);
    }
    if (process.env.E2E_VERBOSE) console.log(output.slice(-4000));
  } finally {
    for (const s of sessions) s.close();
    // Whatever is left of a shim, its bundle, its LS record and its data.
    if (kind === "mac") {
      const pid = pidOf();
      if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
      for (const b of installer.listBundles(root)) {
        if (!REAL_ROOT || b.info.CodecastAppSlug === SLUG) installer.uninstall({ appPath: b.path, slug: b.info.CodecastAppSlug });
      }
      if (REAL_ROOT) try { fs.rmdirSync(root); } catch {} // only when it is empty: it held nothing of the person's
      if (!PROD || SLUG.startsWith("e2e")) installer.uninstall({ slug: SLUG });
    }
    await quit();
    shell.server.close();
    if (KEEP) say(`kept ${dir}`);
    else fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    fs.writeFileSync(path.join(SHOTS, `${kind}-electron-output.log`), output);
  }
}

// ── main ──
// Each pass gets a fresh stand-in: a pass republishes and changes the data.
const startPageServer = () => startStandin({ apps: [
  { slug: SLUG, example: "needs-you", gate: { k: KEY }, ...(REAL_ROOT ? { name: "E2E Needs you" } : {}) },
  { slug: "e2estandup", example: "standup-board" },
  { slug: NOICON, example: "standup-board", icon: false },
  { slug: BLOCKED, example: "standup-board", name: "Blocked", policy: { install: false } },
] });
if (PROD) await serverChecks(PAGE_ORIGIN).catch(() => {});
else {
  const s = await startPageServer();
  await serverChecks(s.origin).catch(() => {});
  await s.close();
}
for (const kind of HOSTS) {
  const standin = PROD ? null : await startPageServer();
  try {
    await runHost(kind, standin);
  } finally {
    if (standin) await standin.close();
  }
}
currentHost = "-";
const failed = results.filter((r) => r.status === "fail" || r.status === "soft-fail");
const blockedGates = results.filter((r) => r.status === "blocked");
console.log(`\n${results.filter((r) => r.status === "pass").length} passed, ${failed.length} failed, ${blockedGates.length} blocked, ${results.filter((r) => r.status === "skip").length} skipped. Screenshots: ${SHOTS}`);
for (const r of failed) console.log(`  FAIL  [${r.host}] ${r.name}: ${r.detail}`);
for (const r of blockedGates) console.log(`  BLOCK [${r.host}] ${r.name}: ${r.detail}`);
if (!PROD) console.log("  The page server was the stand-in (installedAppsStandin.test.ts holds it to the real serve route); the edge and prod data are proven only by --prod.");
if (blockedGates.length) console.log(`  Not proven while ${blockedGates.length} gate(s) are blocked.${STRICT ? "" : " --strict fails on them."}`);
fs.writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : STRICT && blockedGates.length ? 3 : 0);
