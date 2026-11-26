#!/usr/bin/env node
// Runs one example as an installed app in the real Electron-window host, from
// source, the way packages/electron/installedApps/host.electron.test.js does:
// Codecast's main.js boots with a throwaway profile (so it never touches the
// installed Codecast), one local server plays the codecast web app and
// answers the install sheet, another plays a.codecast.sh (the page, its
// version header, its icon). The page gets the dev data runtime
// (dev/fake-cast.js) in place of a.codecast.sh's, and the real cast.app from
// the host. Each scenario drives the app over DevTools and saves screenshots.
//
//   node examples/installed-apps/dev/electron-run.mjs <team-queue|standup-board|repo-pulse|repo-pulse-refused> [--shots <dir>] [--show]
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import os from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFake } from "./serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "..");
const ELECTRON_DIR = join(HERE, "../../../packages/electron");
const electronBin = createRequire(join(ELECTRON_DIR, "package.json"))("electron");

const argv = process.argv.slice(2);
const scenario = argv[0];
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const SHOTS = flag("--shots") || join(os.homedir(), ".codecast/tmp/installed-apps-demos");
mkdirSync(SHOTS, { recursive: true });
const APP = scenario === "repo-pulse-refused" ? "repo-pulse" : scenario;
if (!["team-queue", "standup-board", "repo-pulse"].includes(APP)) {
  console.error("usage: electron-run.mjs <team-queue|standup-board|repo-pulse|repo-pulse-refused>");
  process.exit(2);
}
const SLUG = APP;
const DIR = join(EXAMPLES, APP);
const manifest = JSON.parse(readFileSync(join(DIR, "cast-data.json"), "utf8")).app;
const GRANTS = { "team-queue": ["notifications", "menu-bar"], "standup-board": ["notifications", "overlay", "shortcuts"], "repo-pulse": ["full-access"], "repo-pulse-refused": [] }[scenario];

const { sleep, until: waitFor, listen, freePort, attach: attachCdp } = createRequire(import.meta.url)("../../../packages/electron/installedApps/e2e/cdp.js");
const log = (...a) => console.log(`[${scenario}]`, ...a);
const until = (what, fn, timeoutMs = 90_000) => waitFor(what, fn, timeoutMs, 250);

/** A DevTools session (installedApps/e2e/cdp.js) that also saves a 2x shot of its page to SHOTS. */
async function attach(wsUrl) {
  const s = await attachCdp(wsUrl);
  return {
    ...s,
    async shot(name) {
      const { width, height } = await s.eval("({width: innerWidth, height: innerHeight})");
      await s.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
      await sleep(400);
      const png = await s.screenshot();
      await s.send("Emulation.clearDeviceMetricsOverride");
      const file = join(SHOTS, `${name}.png`);
      writeFileSync(file, png);
      log("shot", file);
      return file;
    },
  };
}

// ── a sample repository for Repo pulse: history, then a working tree mid-change ──
function sampleRepo() {
  // Under the home folder, so the app shows it as ~/…/billing, the way a real repo reads.
  const tmp = join(os.homedir(), ".codecast/tmp");
  mkdirSync(tmp, { recursive: true });
  const dir = join(mkdtempSync(join(tmp, "pulse-demo-")), "billing");
  mkdirSync(dir);
  const g = (...args) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: undefined } });
  const write = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
  g("init", "-q", "-b", "main");
  const commits = [
    ["Maya Chen", "Scaffold the billing service", { "src/billing/index.ts": "export {};\n", "README.md": "# billing\n", "docs/setup.md": "# Setup\n" }, 5 * 86400],
    ["Jonah Park", "Add invoice model and tests", { "src/billing/invoice.ts": "export type Invoice = {};\n".repeat(20), "test/invoice.test.ts": "test\n".repeat(30) }, 4 * 86400],
    ["Maya Chen", "Retry webhooks with backoff", { "src/webhooks/retry.ts": "retry\n".repeat(40) }, 2 * 86400],
    ["Ada Okafor", "Fix rounding on prorated plans", { "src/billing/prorate.ts": "prorate\n".repeat(25) }, 9 * 3600],
    ["Jonah Park", "Bump stripe to 18.2", { "package.json": '{ "name": "billing" }\n' }, 3 * 3600],
    ["Ada Okafor", "Log the idempotency key on every charge", { "src/billing/charge.ts": "charge\n".repeat(30) }, 40 * 60],
  ];
  for (const [who, msg, files, ago] of commits) {
    for (const [p, s] of Object.entries(files)) write(p, s);
    g("add", "-A");
    const when = `${Math.floor(Date.now() / 1000 - ago)} +0000`;
    execFileSync("git", ["-c", `user.name=${who}`, "-c", `user.email=${who.split(" ")[0].toLowerCase()}@example.com`, "commit", "-q", "-m", msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  }
  g("tag", "v0.4.0", "HEAD~1");
  write("src/billing/charge.ts", "charge\n".repeat(22) + "idempotency\n".repeat(14));
  write("src/billing/prorate.ts", "prorate\n".repeat(25) + "round half even\n".repeat(3));
  write("src/webhooks/signature.ts", "verify\n".repeat(18));
  g("add", "src/webhooks/signature.ts");
  renameSync(join(dir, "test/invoice.test.ts"), join(dir, "test/invoices.test.ts"));
  g("add", "-A", "test");
  rmSync(join(dir, "README.md"));
  write("notes/todo.md", "- ship it\n");
  return dir;
}

const info = (version, page) => ({
  slug: SLUG, title: manifest.name, version, updated_at: Date.now(),
  app: {
    name: manifest.name, icon: manifest.icon ?? null,
    window: { width: 800, height: 600, minWidth: 200, minHeight: 200, resizable: true, titleBar: "default", ...manifest.window },
    tray: { icon: manifest.tray?.icon ?? null, width: 360, height: 480, tooltip: manifest.name, ...manifest.tray },
    permissions: manifest.permissions ?? [],
  },
  owner: { name: "Ada" },
  icons: { 512: `${page.origin}/${SLUG}?icon=512`, 1024: `${page.origin}/${SLUG}?icon=1024` },
  relation: "owner",
  policy: { install: true, fullAccess: true },
  gate: {},
});

const TYPES = { ".js": "text/javascript", ".png": "image/png", ".ttf": "font/ttf", ".json": "application/json" };
const work = mkdtempSync(join(os.tmpdir(), "ia-electron-"));
const shell = await listen((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>shell</title><body>shell</body>"); });
const page = await listen((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.searchParams.has("icon")) { res.setHeader("Content-Type", "image/png"); return res.end(readFileSync(join(DIR, "icon.png"))); }
  if (url.pathname === `/${SLUG}` || url.pathname === `/${SLUG}/`) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Cast-Version", "1");
    const html = readFileSync(join(DIR, "index.html"), "utf8").replace(/<head[^>]*>/i, (m) => `${m}<base href="/${SLUG}/">`);
    return res.end(withFake(html, `/${SLUG}/__dev/fake-cast.js`).replace("<script src=", "<script>window.__castRecordNotify = true</script><script src="));
  }
  const rel = url.pathname.slice(SLUG.length + 2);
  try {
    const body = rel === "__dev/fake-cast.js" ? readFileSync(join(HERE, "fake-cast.js")) : readFileSync(join(DIR, rel));
    res.setHeader("Content-Type", TYPES[extname(rel)] || "application/octet-stream");
    res.end(body);
  } catch { res.statusCode = 404; res.end("not here"); }
});

const port = await freePort();
const child = spawn(electronBin, [ELECTRON_DIR, "--background"], {
  env: {
    ...process.env, CODECAST_USER_DATA: join(work, "profile"), CODECAST_URL: shell.origin, CODECAST_APPS_HOST: "electron",
    CODECAST_APPS_PAGE_ORIGIN: page.origin, CODECAST_APPS_SHOW: argv.includes("--show") ? "1" : "0", CODECAST_CDP_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));

const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page");
const target = (what, pred, ms) => until(what, async () => (await targets()).find(pred), ms);
const sessions = [];
const open = async (t) => { const s = await attach(t.webSocketDebuggerUrl); sessions.push(s); return s; };
const results = [];
const check = (what, ok, detail = "") => { results.push({ what, ok }); log(ok ? "PASS" : "FAIL", what, detail); };

try {
  const shellPage = await open(await target("the shell window", (t) => t.url.startsWith(`${shell.origin}/inbox`), 180_000));
  await until("the shell bridge", () => shellPage.eval("typeof window.__CODECAST_ELECTRON__?.apps?.install === 'function'"));
  await shellPage.eval(`window.__install = window.__CODECAST_ELECTRON__.apps.install(${JSON.stringify(info(1, page))}); true`);
  const sheetT = await target("the install sheet", (t) => t.url.startsWith(`${shell.origin}/apps/consent/`));
  const sheet = await open(sheetT);
  await until("the sheet bridge", () => sheet.eval("!!window.__CODECAST_ELECTRON__?.apps"));
  const id = decodeURIComponent(sheetT.url.split("/apps/consent/")[1]);
  const asked = (await sheet.eval(`window.__CODECAST_ELECTRON__.apps.consent.get(${JSON.stringify(id)})`)).asked;
  check("the install sheet asks for the manifest's permissions", JSON.stringify(asked) === JSON.stringify(manifest.permissions), JSON.stringify(asked));
  // The sheet closes once answered, so its reply may never come back.
  await sheet.answerConsent(id, { approve: true, grants: GRANTS }).catch(() => {});
  await until("the install", () => shellPage.eval("window.__install"));

  const appT = await target("the app window", (t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=window`));
  const app = await open(appT);
  await until("the page", () => app.eval("document.readyState === 'complete' && !!window.cast?.app"));
  const appInfo = await until("cast.app.info()", () => app.eval("cast.app.info()"));
  check("cast.app.info() names the app and its grants", appInfo.name === manifest.name && JSON.stringify(appInfo.grants) === JSON.stringify(GRANTS), JSON.stringify(appInfo));

  if (scenario === "team-queue") {
    await until("the count", () => app.eval("document.getElementById('count').textContent !== '·'"));
    await sleep(1200);
    check("the count shows 6 (3 in review + 3 open issues)", (await app.eval("document.getElementById('count').textContent")) === "6");
    await app.shot("team-queue-window");
    // A new issue opens and one more task reaches review: both notify.
    await app.eval(`(() => {
      window.__sent.length = 0;
      const t = new Date().toISOString();
      __fake.data("incidents", [
        ["eg-417", "RangeError: Maximum call stack size exceeded in mergeLiveTasks", "error", "open", 12, t],
        ["eg-412", "TypeError: Cannot read properties of undefined (reading 'session_id')", "error", "open", 190, t],
        ["eg-409", "sync push timed out after 30s", "error", "open", 41, new Date(Date.now() - 5e6).toISOString()],
        ["eg-398", "Health check failed: convex-prod /version", "health", "open", 6, new Date(Date.now() - 18e6).toISOString()]]);
      __fake.data("tasks", [["in_review", 4], ["open", 7], ["in_progress", 4]]);
      return true; })()`);
    await sleep(1500);
    const sent = await app.eval("window.__sent");
    check("a new issue and a new review each send one notification, tagged", sent.some((n) => n.tag === "eg-417") && sent.some((n) => n.tag === "review") && !sent.some((n) => n.failed), JSON.stringify(sent));
    await app.shot("team-queue-window-new-issue");
    await shellPage.eval(`window.__CODECAST_ELECTRON__.apps.open(${JSON.stringify(SLUG)}, {surface: "tray"})`);
    const tray = await open(await target("the menu bar popover", (t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=tray`)));
    await until("the popover page", () => tray.eval("document.readyState === 'complete' && document.body.classList.contains('tray') && document.getElementById('count').textContent !== '·'"));
    check("the popover runs at surface tray", (await tray.eval("cast.app.info()")).surface === "tray");
    await sleep(800);
    await tray.shot("team-queue-tray");
    // Window and popover both open, the same push reaches both pages: one notification, from the window.
    const push = (rows) => `(() => { window.__sent.length = 0; __fake.data("incidents", ${JSON.stringify(rows)}); return true; })()`;
    const now = new Date().toISOString();
    const base = [
      ["eg-417", "RangeError: Maximum call stack size exceeded in mergeLiveTasks", "error", "open", 12, now],
      ["eg-412", "TypeError: Cannot read properties of undefined (reading 'session_id')", "error", "open", 190, now],
      ["eg-409", "sync push timed out after 30s", "error", "open", 41, now],
      ["eg-398", "Health check failed: convex-prod /version", "health", "open", 6, now]];
    const withOne = [["eg-420", "Webhook signature mismatch on /stripe", "error", "open", 3, now], ...base];
    await Promise.all([app.eval(push(withOne)), tray.eval(push(withOne))]);
    await sleep(1500);
    const both = [...(await app.eval("window.__sent")).map((n) => ({ ...n, from: "window" })), ...(await tray.eval("window.__sent")).map((n) => ({ ...n, from: "tray" }))];
    check("with window and popover open, a new issue notifies once, from the window", both.length === 1 && both[0].tag === "eg-420" && both[0].from === "window", JSON.stringify(both));
    // The window closes: the popover takes over telling the person.
    await app.eval("cast.app.window.close().catch(() => {}); true").catch(() => {});
    await until("the window to go", async () => !(await targets()).some((t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=window`)), 20_000).catch(() => {});
    await sleep(800);
    const withTwo = [["eg-421", "Queue worker restarted 4 times", "error", "open", 4, now], ...withOne];
    await tray.eval(push(withTwo));
    await sleep(1500);
    const alone = await tray.eval("window.__sent");
    check("with only the popover open, it notifies the new issue once", alone.length === 1 && alone[0].tag === "eg-421", JSON.stringify(alone));
  }

  if (scenario === "standup-board") {
    const day = await app.eval("(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()");
    await app.eval(`(() => {
      __fake.as("Sam Rivera", "standup", "${day}:sam-rivera", { day: "${day}", name: "Sam Rivera", yesterday: "Shipped the retry queue behind a flag", today: "Load test the queue at 2x prod\\nPair with @Priya on alerts", blocked: "" });
      __fake.as("Priya Nair", "standup", "${day}:priya-nair", { day: "${day}", name: "Priya Nair", yesterday: "Alert routing for the EU region", today: "Write the on-call runbook", blocked: "Need prod read access for the runbook queries" });
      __fake.as("Leo Martins", "standup", "${day}:leo-martins", { day: "${day}", name: "Leo Martins", yesterday: "Reviewed the billing PRs", today: "Migrate invoices to the new schema", blocked: "" });
      localStorage.setItem("fake-state:standup-board:standup", JSON.stringify(JSON.parse(localStorage.getItem("fake-state:standup-board:standup")).concat([{ key: "${day}:ada", value: { day: "${day}", name: "Ada", yesterday: "Fixed the rounding bug on prorated plans", today: "Idempotency keys on every charge\\nReview @Leo's migration", blocked: "" }, by: { name: "Ada", avatar: null }, created_at: Date.now() - 3e6, updated_at: Date.now() - 3e6 }])));
      location.reload(); return true; })()`);
    await sleep(1500);
    const app2 = await open(await target("the reloaded board", (t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=window`)));
    await until("the rows", () => app2.eval("document.querySelectorAll('.row').length === 4"));
    await until("the shortcut", () => app2.eval("document.querySelectorAll('#add kbd').length === 3"), 20_000).then(() => check("the global shortcut registers and shows on Update", true), () => check("the global shortcut registers and shows on Update", false));
    await sleep(900);
    await app2.shot("standup-board-window");
    // A teammate marks Ada as the one blocking them: one notification, tagged with their row.
    await app2.eval(`(() => {
      window.__sent.length = 0;
      __fake.as("Leo Martins", "standup", "${day}:leo-martins", { day: "${day}", name: "Leo Martins", yesterday: "Reviewed the billing PRs", today: "Migrate invoices to the new schema", blocked: "Waiting on @Ada to merge the charge refactor" });
      return true; })()`);
    await sleep(1200);
    const sent = await app2.eval("window.__sent");
    check("a teammate blocked on you sends one notification", sent.length === 1 && sent[0].title === "Leo Martins is blocked on you" && sent[0].tag === `${day}:leo-martins`, JSON.stringify(sent));
    await app2.eval("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'b', bubbles: true})); true");
    await sleep(600);
    await app2.eval("document.getElementById('qa-text').value = 'Prod read access for the runbook'; true");
    await app2.shot("standup-board-quick-add");
    await app2.eval("document.getElementById('quick').close(); document.getElementById('pin').click(); true");
    await until("the pinned window", () => app2.eval("innerWidth <= 380 && document.getElementById('pin').getAttribute('aria-pressed') === 'true'"), 20_000);
    check("Pin keeps the window on top and shrinks it", true);
    await sleep(800);
    await app2.shot("standup-board-pinned");
  }

  if (scenario === "repo-pulse") {
    const repo = sampleRepo();
    await app.eval(`localStorage.setItem("repo-pulse:recent", JSON.stringify([${JSON.stringify(repo)}, "~/src/codecast"])); location.reload(); true`);
    await sleep(1500);
    const app2 = await open(await target("the reloaded app", (t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=window`)));
    await until("the files", () => app2.eval("document.querySelectorAll('.file').length > 0 && document.querySelectorAll('.commit').length > 0"));
    const files = await app2.eval("[...document.querySelectorAll('.file')].map(f => f.querySelector('.st').textContent + ' ' + f.dataset.p)");
    check("git status shows each kind of change", ["M src/billing/charge.ts", "A src/webhooks/signature.ts", "R test/invoices.test.ts", "D README.md", "? notes/"].every((f) => files.includes(f)), JSON.stringify(files));
    check("git log shows the six commits", (await app2.eval("document.querySelectorAll('.commit').length")) === 6);
    await until("the watches", () => app2.eval("document.getElementById('live').classList.contains('on')"));
    await sleep(900);
    await app2.shot("repo-pulse-window");
    // An edit lands in a watched folder: the list refreshes by itself.
    writeFileSync(join(repo, "src/billing/invoice.ts"), "export type Invoice = { id: string };\n");
    await until("the watch to refresh the list", () => app2.eval("[...document.querySelectorAll('.file')].some(f => f.dataset.p === 'src/billing/invoice.ts')"), 15_000)
      .then(() => check("fs.watch refreshes the list after an edit", true), (e) => check("fs.watch refreshes the list after an edit", false, e.message));
    await sleep(300);
    await app2.shot("repo-pulse-after-edit");
    // An edit in a folder nothing watches yet (docs/ had no changes): the periodic look catches it.
    const watched = await app2.eval("document.getElementById('live').textContent");
    writeFileSync(join(repo, "docs/setup.md"), "# Setup\n\nRun bun install.\n");
    const t0 = Date.now();
    await until("the periodic look to show docs/setup.md", () => app2.eval("[...document.querySelectorAll('.file')].some(f => f.dataset.p === 'docs/setup.md')"), 15_000)
      .then(() => check("an edit in an unwatched folder shows within seconds", true, `${Date.now() - t0} ms, ${watched}`), (e) => check("an edit in an unwatched folder shows within seconds", false, e.message));
    const shown = await app2.eval("({ field: document.getElementById('path').value, title: document.getElementById('titlebar').textContent, hidden: document.hidden })");
    check("the field collapses the home folder and the title names the repo", shown.field.startsWith("~/") && shown.field.endsWith("/billing") && shown.title === "billing", JSON.stringify(shown));
    rmSync(dirname(repo), { recursive: true, force: true });
  }

  if (scenario === "repo-pulse-refused") {
    await app.eval(`localStorage.setItem("repo-pulse:recent", JSON.stringify(["~/src"])); location.reload(); true`);
    await sleep(1500);
    const app2 = await open(await target("the reloaded app", (t) => t.url.startsWith(`${page.origin}/${SLUG}?host=app&surface=window`)));
    await until("the refusal", () => app2.eval("!!document.querySelector('.state .why')"));
    const why = await app2.eval("document.querySelector('.state .why').textContent");
    check("without full access the app shows the refusal's code", why === "needs-consent", why);
    await sleep(600);
    await app2.shot("repo-pulse-refused");
  }
} catch (err) {
  const last = sessions[sessions.length - 1];
  const seen = last ? await last.eval("document.body.innerText.slice(0, 1500)").catch((e) => `(unreadable: ${e.message})`) : "";
  console.error(err.message, `\n--- the page said ---\n${seen}\n--- electron output ---\n${output.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  for (const s of sessions) s.close();
  child.kill("SIGTERM");
  await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  shell.server.close();
  page.server.close();
  rmSync(work, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}
