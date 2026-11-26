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
// On Windows it also checks what the host writes outside the profile: the
// Start menu shortcut, which must carry the app's AUMID and launch it, a
// toast shown through that AUMID (the PowerShell the host runs, parsed and run
// here so its result can be read), and the open-at-login Run value.
//
// CODECAST_APPS_SHOW=1 shows the app window (it is off screen by default);
// CODECAST_APPS_SHOTS=<dir> saves screenshots of the app window there, and
// shows it: a window that was never shown paints no frame on Windows, so
// Page.captureScreenshot would wait forever for one.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { solidPng } = require("./testPng");
const { sleep, until, freePort, listen, attach } = require("./e2e/cdp");
const { windowsToastScript, aumid } = require("./electronHost");

const SLUG = "apptest01";
const ELECTRON_DIR = path.join(__dirname, "..");

const real = (p) => fs.realpathSync.native(p).toLowerCase();

/** Runs a PowerShell script (Windows only); resolves {code, stdout, stderr}. */
function powershell(script, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

// What the toast script runs, in order: anything else is text that escaped its quotes.
const TOAST_COMMANDS = ["Out-Null", "Out-Null", "New-Object", "New-Object", "Write-Output"];

/**
 * Parses the toast script and lists the commands in it, then runs it. Resolves
 * {parseErrors, commands, result} or, when a line throws, {threw: {line, message}}.
 */
async function runToast(script) {
  const r = await powershell(
    [
      "$errs = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($env:TOAST, [ref]$null, [ref]$errs)",
      "$commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })",
      "$out = [ordered]@{ parseErrors = $errs.Count; commands = $commands }",
      "if ($errs.Count -eq 0) {",
      "  try { $out.result = (& ([scriptblock]::Create($env:TOAST)) | Select-Object -Last 1) }",
      "  catch { $out.threw = @{ line = $_.InvocationInfo.Line.Trim(); message = $_.Exception.Message } }",
      "}",
      "$out | ConvertTo-Json -Compress",
    ].join("\n"),
    { TOAST: script },
  );
  assert.equal(r.code, 0, `running the toast script: ${r.stderr}`);
  return JSON.parse(r.stdout.split("\n").pop());
}

/** The HKCU Run value `name`, or null when there is none. */
async function readRunValue(name) {
  const r = await powershell(
    [
      "$v = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).$env:RUN_NAME",
      "if ($null -eq $v) { 'null' } else { $v | ConvertTo-Json -Compress }",
    ].join("\n"),
    { RUN_NAME: name },
  );
  assert.equal(r.code, 0, `reading the Run value: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** A .lnk file's AUMID, target and arguments, read the way the shell reads them. */
async function readShortcut(file) {
  const r = await powershell(
    [
      "$ErrorActionPreference = 'Stop'",
      "$f = Get-Item -LiteralPath $env:LNK",
      "$item = (New-Object -ComObject Shell.Application).NameSpace($f.DirectoryName).ParseName($f.Name)",
      "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($f.FullName)",
      "[pscustomobject]@{ aumid = $item.ExtendedProperty('System.AppUserModel.ID'); target = $s.TargetPath; arguments = $s.Arguments } | ConvertTo-Json -Compress",
    ].join("\n"),
    { LNK: file },
  );
  assert.equal(r.code, 0, `reading ${file}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
test("install, call, republish and uninstall an app in the Electron-window host", { skip: process.platform === "linux" ? "main.js boots only on macOS and Windows" : false, timeout: process.platform === "win32" ? 240_000 : 120_000 }, async (t) => {
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
      permissions: ["notifications", "login", "full-access"],
    },
    owner: { name: "Test" },
    icons: { 512: `${page.origin}/${SLUG}?icon=512&k=key1`, 1024: `${page.origin}/${SLUG}?icon=1024&k=key1` },
    relation: "owner",
    policy: { install: true, fullAccess: true },
    gate: { k: "key1" },
  });

  const port = await freePort();
  const show = process.env.CODECAST_APPS_SHOW === "1" || !!process.env.CODECAST_APPS_SHOTS;
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
    assert.deepEqual(request.asked, ["notifications", "login", "full-access"]);
    assert.equal(request.info.slug, SLUG);
    // The sheet closes once answered, so the answer's own reply may never get back over CDP.
    await sheet.answerConsent(id, { approve: true, grants: ["notifications", "login", "full-access"] });
    assert.deepEqual(await shellPage.eval("window.__install"), { installed: true, slug: SLUG });

    // The app window: its page, its partition, its bridge.
    const appTarget = await target("the app window", (t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=window&k=key1`));
    const appPage = await open(appTarget);
    await until("the page", () => appPage.eval("window.__loadedVersion === 7"));
    const ua = await appPage.eval("navigator.userAgent");
    assert.match(ua, new RegExp(` CodecastApp/[^ ]+ \\(${SLUG}\\)$`));
    const appInfo = await appPage.eval("cast.app.info()");
    assert.deepEqual({ ...appInfo, platform: undefined }, { slug: SLUG, name: "Test App", version: 7, surface: "window", platform: undefined, grants: ["notifications", "login", "full-access"], requested: ["notifications", "login", "full-access"] });
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

    if (process.platform === "win32") {
      assert.ok(record.shortcutPath && fs.existsSync(record.shortcutPath), `the Start menu shortcut exists (${record.shortcutPath})`);
      assert.ok(fs.existsSync(record.icons.ico), "an .ico was written for the shortcut and the taskbar");
      const lnk = await readShortcut(record.shortcutPath);
      assert.equal(lnk.aumid, aumid(SLUG), "the shortcut carries the app's own AUMID");
      assert.equal(real(lnk.target), real(require("electron")), "the shortcut starts this Codecast");
      assert.match(lnk.arguments, new RegExp(`--codecast-app=${SLUG}$`));
      // The page's own call goes through (it is queued, so this proves the
      // grant and the pacing); the script it runs is checked on its own below.
      await appPage.eval("cast.app.notify({ title: 'From the test', body: 'via cast.app.notify' })");
      // A toast through the AUMID the shortcut carries: a curly quote in the
      // title must reach the toast as text, and the toast must not fail.
      const toast = await runToast(windowsToastScript({ appId: aumid(SLUG), slug: SLUG, title: "Test App\u2019s toast", body: "<b>&</b>", tag: "e2e", silent: true }));
      assert.equal(toast.parseErrors, 0, "the toast script parses");
      assert.deepEqual(toast.commands, TOAST_COMMANDS, "and runs only its own commands");
      if (toast.threw) {
        // A runner with no notification platform refuses Show; nothing before it may fail.
        assert.match(toast.threw.line, /^\[Windows\.UI\.Notifications\.ToastNotificationManager\]::CreateToastNotifier\(/, `the toast script failed: ${toast.threw.message}`);
        t.diagnostic(`no toast on this runner: ${toast.threw.message}`);
      } else {
        assert.equal(toast.result, "shown", `the toast reported ${toast.result}`);
      }
      // Open at login: a Run value that starts this Codecast, its exe quoted
      // by Electron and the app path by the host, then removed again.
      await appPage.eval("cast.app.login.set(true)");
      const run = await readRunValue(`CodecastApp-${SLUG}`);
      const parts = run && run.match(/^"([^"]+)" "([^"]+)" --codecast-app=(\S+)$/);
      assert.ok(parts, `the Run value is a quoted exe, the quoted app path and the slug: ${run}`);
      assert.equal(real(parts[1]), real(require("electron")));
      assert.equal(real(parts[2]), real(ELECTRON_DIR));
      assert.equal(parts[3], SLUG);
      await appPage.eval("cast.app.login.set(false)");
      assert.equal(await readRunValue(`CodecastApp-${SLUG}`), null, "turning it off removes the Run value");
    }

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
    await review.answerConsent(reviewId, { approve: true, grants: ["full-access"] });
    await until("grants for version 8", async () => (await shellPage.eval("window.__CODECAST_ELECTRON__.apps.list()"))[0].grantedVersion === 8);
    assert.equal(await reloaded.eval(`cast.app.fs.readText(${JSON.stringify(scratch)})`), "written by the app");

    // Signed out, the app window shows the cover instead of the page; signed back in, the page returns.
    await shellPage.eval("window.__CODECAST_ELECTRON__.apps.setSignedIn(false); true");
    const coverTarget = await target("the signed-out cover", (t) => t.url.startsWith("data:text/html"));
    const cover = await open(coverTarget);
    // The target is listed before its document has parsed.
    assert.match(await until("the cover's text", () => cover.eval("document.body?.innerText")), /Codecast is signed out[\s\S]*Sign in to Codecast to use Test App\./);
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).installedAppsSignedIn, false);
    await shellPage.eval("window.__CODECAST_ELECTRON__.apps.setSignedIn(true); true");
    const back = await open(await target("the page after sign-in", (t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=window`)));
    await until("the page after sign-in", () => back.eval("window.__loadedVersion === 8"));

    // Uninstall: the window goes, and so does the record.
    assert.equal(await shellPage.eval(`window.__CODECAST_ELECTRON__.apps.uninstall(${JSON.stringify(SLUG)})`), true);
    await until("the app window to close", async () => !(await targets()).some((t) => t.url.startsWith(`${page.origin}/${SLUG}`)));
    assert.deepEqual(await shellPage.eval("window.__CODECAST_ELECTRON__.apps.list()"), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).installedApps, {});
    if (process.platform === "win32") assert.equal(fs.existsSync(record.shortcutPath), false, "uninstall removed the Start menu shortcut");
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
    // Electron's helper processes can hold the profile open on Windows for a moment after the main one exits.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {}
  }
});
