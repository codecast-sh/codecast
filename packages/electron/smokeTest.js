// `--smoke-test=<dir>`: start, open the main window, wait for its page, save a
// screenshot and a JSON report into <dir>, and quit with 0 when the page
// loaded and 1 when it did not. CI runs it against a freshly installed build
// (.github/workflows/desktop-windows.yml) to prove the app boots on a machine
// that has never seen it; the same flag works on macOS from source.
//
// Electron is not required here: the window comes in, so this tests under
// plain node.

const fs = require("fs");
const path = require("path");

// The settle after the page loads, so the screenshot shows the drawn app and
// not its first frame.
const SETTLE_MS = 3000;
const DEFAULT_TIMEOUT_MS = 60_000;

// { dir, timeoutMs } from argv, or null when the flag is absent. A bare
// `--smoke-test` writes into ./smoke-test. `--smoke-timeout=<seconds>` bounds
// the wait for the page.
function smokeTestOptions(argv) {
  const flag = argv.find((a) => a === "--smoke-test" || a.startsWith("--smoke-test="));
  if (!flag) return null;
  const dir = path.resolve(flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : "smoke-test");
  const secs = Number(argv.find((a) => a.startsWith("--smoke-timeout="))?.split("=")[1]);
  return { dir, timeoutMs: secs > 0 ? secs * 1000 : DEFAULT_TIMEOUT_MS };
}

// Resolves when `contents` finishes loading a page that `isLoaded` accepts
// (the shell's recovery page is a load, not a success), or rejects at the
// deadline with the last URL it saw.
function waitForPage(contents, { timeoutMs, isLoaded }) {
  return new Promise((resolve, reject) => {
    const done = () => {
      if (!isLoaded(contents.getURL())) return;
      clearTimeout(timer);
      contents.removeListener("did-finish-load", done);
      resolve();
    };
    const timer = setTimeout(() => {
      contents.removeListener("did-finish-load", done);
      reject(new Error(`page did not load within ${timeoutMs} ms (at ${contents.getURL() || "nothing"})`));
    }, timeoutMs);
    contents.on("did-finish-load", done);
    if (!contents.isLoadingMainFrame() && contents.getURL()) done();
  });
}

// Polls `isDrawn()` (a probe run in the page) until it answers true or the
// deadline passes. A finished load is only the document: the app draws later,
// behind its boot screen.
async function waitForDrawn(isDrawn, deadline) {
  for (;;) {
    if (await isDrawn().catch(() => false)) return;
    if (Date.now() >= deadline) throw new Error("page loaded but never drew past its boot screen");
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Runs the check against `win` and writes screenshot.png and report.json into
// opts.dir. Never throws: a failure is a report with ok false. `info` is
// merged into the report (version, platform, arch). `drawnProbe` is page
// JavaScript that evaluates to true once the app has drawn.
async function runSmokeTest(win, { dir, timeoutMs, isLoaded = () => true, drawnProbe = "true", info = {}, settleMs = SETTLE_MS }) {
  const started = Date.now();
  const report = { ok: false, ...info, url: null, title: null, screenshot: null, elapsedMs: 0, error: null };
  fs.mkdirSync(dir, { recursive: true });
  const contents = win.webContents;
  try {
    await waitForPage(contents, { timeoutMs, isLoaded });
    await waitForDrawn(() => contents.executeJavaScript(drawnProbe), started + timeoutMs);
    await new Promise((r) => setTimeout(r, settleMs));
    report.ok = true;
  } catch (e) {
    report.error = e?.message || String(e);
  }
  report.url = contents.getURL();
  report.title = contents.getTitle();
  try {
    const image = await win.capturePage();
    const png = image.toPNG();
    if (png.length === 0) throw new Error("empty capture");
    const file = path.join(dir, "screenshot.png");
    fs.writeFileSync(file, png);
    report.screenshot = file;
  } catch (e) {
    report.ok = false;
    report.error = [report.error, `screenshot: ${e?.message || e}`].filter(Boolean).join("; ");
  }
  report.elapsedMs = Date.now() - started;
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

module.exports = { smokeTestOptions, runSmokeTest, waitForPage };
