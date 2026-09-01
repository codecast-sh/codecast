#!/usr/bin/env bun
/**
 * End-to-end smoke test for the extension bridge.
 *
 * What it proves: a REAL Chrome tab can be driven through the chain
 * client → bridge host (a CDP endpoint on localhost) → extension →
 * chrome.debugger, by BOTH clients that matter:
 *
 *   1. the built-in driver — every MVP verb (open, snapshot, find, click,
 *      type, press, eval, shot, tabs) via `cast browser --real`;
 *   2. agent-browser (the engine) — `--cdp <bridge url>` open, snapshot,
 *      click, screenshot, tab list. Skipped with a note if no engine binary
 *      is installed;
 *   3. a raw CDP client on the bridge, for what only the bridge adds: a
 *      background create into a named tab group, the group title animating
 *      while a command runs, the border overlay around the driven page, and
 *      a screenshot that does not show it.
 *
 * It launches a SEPARATE Chrome with a scratch profile (never your running
 * browser) and loads the extension unpacked. One piece of scaffolding: the
 * scratch Chrome gets a temporary CDP port used ONLY to paste the token into
 * the extension's storage — the step a human does by hand in the options
 * page. The verbs under test never touch that port; the bridge runs on its
 * own port and neither client knows the CDP one exists.
 *
 * Run:  bun packages/browser-extension/smoke.mjs
 * Env:  SMOKE_HEADED=1 to watch it happen in a visible window.
 *       SMOKE_ENGINE=/path/to/agent-browser to pick the engine binary.
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const extDir = path.join(repoRoot, "packages/browser-extension");
const cliEntry = path.join(repoRoot, "packages/cli/src/index.ts");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "cast-bridge-smoke-"));
const castDir = path.join(work, "castdir");
const profileDir = path.join(work, "profile");
fs.mkdirSync(castDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const env = {
  ...process.env,
  CODECAST_DIR: castDir, // isolate bridge/token/tab state from the machine's real one
  CAST_BRIDGE_PORT: String(await freePort()),
  CAST_SESSION_ID: "smoke-bridge",
  CAST_BROWSER_LEGACY: "1", // once the engine gate lands, keep the built-in driver under test here
};

const results = [];
let chrome = null;
let pageServer = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function cast(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("bun", [cliEntry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, all: out + err });
    });
  });
}

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}

/**
 * The agent-browser binary, if any. Mirrors engine.ts's probe order (env
 * override, PATH, the repo's node_modules, cast's managed copy); switch to
 * importing findEngine once the engine branch lands next to this one.
 */
function findEngine() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.SMOKE_ENGINE) candidates.push(process.env.SMOKE_ENGINE);
  if (process.env.CAST_BROWSER_ENGINE) candidates.push(process.env.CAST_BROWSER_ENGINE);
  try {
    const onPath = execSync("which agent-browser", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (onPath) candidates.push(onPath);
  } catch {}
  candidates.push(
    path.join(repoRoot, "node_modules/.bin/agent-browser"),
    path.join(home, ".codecast/browser/engine/node_modules/.bin/agent-browser"),
  );
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

function engine(binary, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      env: { ...process.env, AGENT_BROWSER_SESSION: "smoke-bridge-engine", AGENT_BROWSER_NAMESPACE: "cast-smoke", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, all: out + err });
    });
  });
}

/**
 * Branded Google Chrome 137+ silently IGNORES --load-extension, so the smoke
 * needs an unbranded build: Chrome for Testing (puppeteer/playwright caches)
 * or Chromium. Branded Chrome is the last resort, with a loud warning —
 * there the run fails at "service worker never appeared".
 */
function findChrome() {
  const home = os.homedir();
  const candidates = [];
  const glob = (dir, suffix) => {
    try {
      for (const entry of fs.readdirSync(dir)) candidates.push(path.join(dir, entry, suffix));
    } catch {}
  };
  if (process.platform === "darwin") {
    const cft = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    glob(path.join(home, "Library/Caches/ms-playwright"), path.join("chrome-mac-arm64", cft));
    glob(path.join(home, ".cache/puppeteer/chrome"), path.join("chrome-mac-arm64", cft));
    candidates.push(
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else {
    glob(path.join(home, ".cache/puppeteer/chrome"), path.join("chrome-linux64", "chrome"));
    candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");
  }
  const found = candidates.filter((p) => fs.existsSync(p)).sort().reverse(); // newest cache version first
  if (!found.length) {
    throw new Error(
      "no Chromium/Chrome-for-Testing binary found — install one with `npx @puppeteer/browsers install chrome@stable`",
    );
  }
  const pick = found[0];
  if (pick.includes("Google Chrome.app")) {
    console.log("WARN: only branded Google Chrome found — 137+ ignores --load-extension; expect failure.");
  }
  return pick;
}

// Minimal CDP client for the one-time token seeding.
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
  }
  static async connect(port, token) {
    const res = await fetch(`http://127.0.0.1:${port}/json/version${token ? `?token=${token}` : ""}`);
    const { webSocketDebuggerUrl } = await res.json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 10_000);
    });
  }
}

/**
 * An extension context to evaluate in: the options page, opened through the
 * scratch Chrome's CDP port. Evaluating in the service worker directly hangs
 * whenever the worker has gone dormant (CDP attach does not wake a stopped
 * MV3 worker), but an extension PAGE has the same chrome.* APIs, and
 * messaging from it is exactly what wakes the worker up. Used to seed the
 * token (the by-hand step) and to read tab groups, which CDP cannot see.
 */
async function extensionContext(cdpPort) {
  const cdp = await Cdp.connect(cdpPort);
  const deadline = Date.now() + 20_000;
  let extId = null;
  while (!extId) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const sw = targetInfos.find(
      (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("background.js"),
    );
    if (sw) extId = new URL(sw.url).host;
    else if (Date.now() > deadline) throw new Error("extension service worker never appeared — is this a branded Chrome ≥137?");
    else await new Promise((r) => setTimeout(r, 400));
  }
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options.html`, background: true });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  return {
    cdp,
    /** Evaluate an expression (a promise is awaited) and return its value. */
    async eval(expression) {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ": " + JSON.stringify(r.exceptionDetails.exception?.description));
      return r.result?.value;
    },
    close: () => cdp.send("Target.closeTarget", { targetId }).catch(() => {}),
  };
}

async function seedToken(ext, token, bridgePort) {
  const expr = `chrome.storage.local.set({ bridge: { token: ${JSON.stringify(token)}, port: ${bridgePort} } })
    .then(() => chrome.runtime.sendMessage({ op: "reconnect" }))
    .then(() => "seeded")`;
  const evalDeadline = Date.now() + 15_000;
  for (;;) {
    const v = await ext.eval(expr).catch(() => null);
    if (v === "seeded") return;
    if (Date.now() > evalDeadline) throw new Error("seeding via options page failed");
    await new Promise((r2) => setTimeout(r2, 500)); // page may still be booting
  }
}

/**
 * The top-left pixel of a PNG as [r, g, b]. Every PNG filter leaves the
 * first pixel of the first row untouched (its neighbours are all zero), so
 * decoding the IDAT stream and reading the bytes after the filter byte is
 * enough. Only 8-bit RGB and RGBA, which is what Chrome writes.
 */
function pngTopLeftPixel(buf) {
  let off = 8;
  let channels = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      if (data[8] !== 8) throw new Error("png: only 8-bit samples supported");
      channels = { 2: 3, 6: 4 }[data[9]];
      if (!channels) throw new Error("png: only RGB/RGBA supported");
    } else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

const BORDER_ID = "cast-browser-bridge-border";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What only the bridge adds on top of CDP, exercised as a raw client the way
 * the engine path will: a background create into a session group, the group
 * following the socket, the working indicator on the group title, the border
 * overlay (present, click-transparent, surviving navigation, gone on detach)
 * and a screenshot that never shows it.
 */
async function bridgeExtras(bridgePort, token, ext, cdpPort, pageUrl) {
  const bridge = await Cdp.connect(bridgePort, token);
  const group = { title: "cast smoke", color: "blue" };
  const tabIdOf = (targetId) => parseInt(targetId, 16);

  const first = await bridge.send("Target.createTarget", { url: pageUrl, background: true, castGroup: group });
  const second = await bridge.send("Target.createTarget", { url: pageUrl });
  const tabs = [tabIdOf(first.targetId), tabIdOf(second.targetId)];
  const created = await ext.eval(`chrome.tabs.get(${tabs[0]}).then((t) => ({ active: t.active, groupId: t.groupId }))`);
  check("bridge: background create is not the active tab", created.active === false, JSON.stringify(created));
  const groupInfo = await ext.eval(
    `chrome.tabGroups.query({ title: ${JSON.stringify(group.title)} }).then(async (gs) => ({
      count: gs.length, color: gs[0]?.color, tabs: gs[0] ? (await chrome.tabs.query({ groupId: gs[0].id })).map((t) => t.id) : [] }))`,
  );
  check(
    "bridge: both creates on one socket share one group with the title and colour",
    groupInfo.count === 1 && groupInfo.color === "blue" && tabs.every((id) => groupInfo.tabs.includes(id)),
    JSON.stringify(groupInfo),
  );
  const { sessionId } = await bridge.send("Target.attachToTarget", { targetId: first.targetId, flatten: true });
  const page = (expression) =>
    bridge.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId).then((r) => r.result?.value);
  const borderState = () => page(`(() => {
    const e = document.getElementById(${JSON.stringify(BORDER_ID)});
    if (!e) return { present: false };
    const cs = getComputedStyle(e);
    return { present: true, color: cs.borderTopColor, pointer: cs.pointerEvents, visibility: cs.visibility,
      hit: document.elementFromPoint(1, 1)?.id === e.id };
  })()`);
  const border = await borderState();
  check(
    "bridge: border overlay present in the group colour and transparent to hit tests",
    border.present && border.color === "rgb(26, 115, 232)" && border.pointer === "none" && border.hit === false,
    JSON.stringify(border),
  );

  // A slow command: the group title should cycle dots meanwhile, then show a checkmark.
  const slow = bridge.send("Runtime.evaluate", { expression: "new Promise((r) => setTimeout(r, 1500))", awaitPromise: true }, sessionId);
  const titles = new Set();
  const groupTitle = () => ext.eval(`chrome.tabGroups.query({ color: "blue" }).then((gs) => gs[0]?.title)`);
  for (let i = 0; i < 12; i++) {
    titles.add(await groupTitle());
    await sleep(100);
  }
  await slow;
  const withDots = [...titles].filter((t) => /^cast smoke\.{1,3}$/.test(t));
  check("bridge: group title animates while a command is in flight", withDots.length >= 2, JSON.stringify([...titles]));
  await sleep(150);
  const afterwards = await groupTitle();
  check("bridge: checkmark after the command", afterwards === "cast smoke ✓", JSON.stringify(afterwards));
  // The plain title is what the host is told, never a frame of the animation.
  const listed = await fetch(`http://127.0.0.1:${bridgePort}/json/list?token=${token}`).then((r) => r.json());
  check("bridge: /json/list carries no group", listed.every((t) => !("group" in t) && !("castGroup" in t)), JSON.stringify(listed).slice(0, 200));

  await bridge.send("Page.navigate", { url: pageUrl + "?again" }, sessionId);
  let survived = null;
  for (let i = 0; i < 30 && !survived?.present; i++) {
    await sleep(100);
    survived = await borderState().catch(() => null);
  }
  check("bridge: border survives navigation", !!survived?.present, JSON.stringify(survived));

  // Chrome's own port sees the same tab (found by its unique URL now) with
  // nothing hiding the frame: its capture shows the blue corner. That is what
  // makes the white corner through the bridge a real result.
  const chromeCdp = await Cdp.connect(cdpPort);
  const { targetInfos } = await chromeCdp.send("Target.getTargets");
  const real = targetInfos.find((t) => t.url === pageUrl + "?again");
  const s2 = real ? (await chromeCdp.send("Target.attachToTarget", { targetId: real.targetId, flatten: true })).sessionId : null;
  const rawShot = s2 ? await chromeCdp.send("Page.captureScreenshot", { format: "png" }, s2) : null;
  const rawPx = rawShot ? pngTopLeftPixel(Buffer.from(rawShot.data, "base64")) : [];
  check("bridge: a capture that skips the bridge shows the border", rawPx[2] > 200 && rawPx[0] < 100, `pixel ${rawPx.join(",")}`);

  const shot = await bridge.send("Page.captureScreenshot", { format: "png" }, sessionId);
  const px = pngTopLeftPixel(Buffer.from(shot.data, "base64"));
  const restored = await borderState();
  check("bridge: screenshot through the bridge hides the border", px[0] > 200 && px[1] > 200 && px[2] > 200, `pixel ${px.join(",")}`);
  check("bridge: border visible again after the screenshot", restored.present && restored.visibility === "visible", JSON.stringify(restored));

  await sleep(3200);
  check("bridge: plain title restored a few seconds after", (await groupTitle()) === "cast smoke", JSON.stringify(await groupTitle()));

  await bridge.send("Target.detachFromTarget", { sessionId });
  await sleep(300);
  // The bridge released the tab, so through Chrome's port the frame must be gone.
  const gone = s2
    ? (await chromeCdp.send("Runtime.evaluate", { expression: `!document.getElementById(${JSON.stringify(BORDER_ID)})`, returnByValue: true }, s2)).result?.value
    : null;
  check("bridge: border removed on detach", gone === true, `target ${real ? "found" : "missing"}, gone=${gone}`);
  chromeCdp.ws.close();

  await bridge.send("Target.closeTarget", { targetId: first.targetId });
  await bridge.send("Target.closeTarget", { targetId: second.targetId });
  await sleep(300);
  const left = await ext.eval(`chrome.tabGroups.query({ title: ${JSON.stringify(group.title)} }).then((gs) => gs.length)`);
  check("bridge: group empties itself when its tabs close", left === 0, `groups left: ${left}`);
  bridge.ws.close();
}

const TEST_PAGE = `<!doctype html><html><head><title>Cast Bridge Smoke</title></head><body>
<h1>Cast Bridge Smoke Page</h1>
<a href="#more">More information</a>
<form onsubmit="document.getElementById('out').textContent='submitted:'+document.getElementById('q').value;return false">
  <input id="q" aria-label="Query">
  <button type="submit">Sign in</button>
</form>
<div id="out"></div>
<script>addEventListener('keydown', e => { window.__lastKey = e.key; });</script>
</body></html>`;

async function main() {
  console.log(`workdir: ${work}\n`);

  // 1. Bridge config + host (isolated under CODECAST_DIR).
  const setup = await cast(["browser", "extension", "setup", "--json"]);
  if (setup.code !== 0) throw new Error("extension setup failed: " + setup.all);
  const { port: bridgePort, token } = JSON.parse(setup.out.trim().split("\n").pop());
  check("bridge host starts and prints token", !!token && !!bridgePort);

  // 2. Local page to act on.
  const pagePort = await freePort();
  pageServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(TEST_PAGE);
  });
  await new Promise((r) => pageServer.listen(pagePort, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${pagePort}/`;

  // 3. Scratch Chrome with the extension loaded unpacked.
  const cdpPort = await freePort();
  const headed = !!process.env.SMOKE_HEADED;
  chrome = spawn(
    findChrome(),
    [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extDir}`,
      `--remote-debugging-port=${cdpPort}`, // token seeding only — see header
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--window-size=1200,900",
      ...(headed ? [] : ["--headless=new"]),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const cdpUp = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      break;
    } catch {
      if (Date.now() > cdpUp) throw new Error("scratch Chrome never opened its CDP port");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  check("scratch Chrome launched with extension", true);

  // 4. Seed the token (the by-hand options-page step, automated).
  const ext = await extensionContext(cdpPort);
  await seedToken(ext, token, bridgePort);
  check("token seeded into extension storage", true);

  // 5. Extension connects to the host.
  let connected = false;
  const connDeadline = Date.now() + 20_000;
  while (Date.now() < connDeadline) {
    const st = await cast(["browser", "extension", "status"]);
    if (/extension connected/.test(st.all)) {
      connected = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check("extension connected to bridge host", connected);
  if (!connected) throw new Error("extension never connected");

  // 6. The MVP verbs, all through --real.
  const open = await cast(["browser", "open", "--real", pageUrl]);
  check("open", open.code === 0 && /Cast Bridge Smoke/.test(open.all), open.all.slice(0, 300));

  const snap = await cast(["browser", "snapshot", "--real"]);
  check(
    "snapshot",
    snap.code === 0 && /Cast Bridge Smoke Page/.test(snap.all) && /#e\d+/.test(snap.all),
    snap.all.slice(0, 300),
  );

  const findBtn = await cast(["browser", "find", "--real", "Sign in"]);
  const btnRef = (findBtn.all.match(/#e(\d+)/) || [])[1];
  check("find (button)", findBtn.code === 0 && !!btnRef, findBtn.all.slice(0, 300));

  const findInput = await cast(["browser", "find", "--real", "Query"]);
  const inputRef = (findInput.all.match(/#e(\d+)/) || [])[1];
  check("find (input)", findInput.code === 0 && !!inputRef, findInput.all.slice(0, 300));

  const typed = await cast(["browser", "type", "--real", `#e${inputRef}`, "hello bridge"]);
  const typedVal = await cast(["browser", "eval", "--real", "document.getElementById('q').value"]);
  check(
    "type",
    typed.code === 0 && /hello bridge/.test(typedVal.out),
    typed.all.slice(0, 200) + " / " + typedVal.all.slice(0, 200),
  );

  const clicked = await cast(["browser", "click", "--real", `#e${btnRef}`]);
  const outText = await cast(["browser", "eval", "--real", "document.getElementById('out').textContent"]);
  check(
    "click",
    clicked.code === 0 && /submitted:hello bridge/.test(outText.out),
    clicked.all.slice(0, 200) + " / " + outText.all.slice(0, 200),
  );

  const pressed = await cast(["browser", "press", "--real", "Escape"]);
  const lastKey = await cast(["browser", "eval", "--real", "window.__lastKey"]);
  check("press", pressed.code === 0 && /Escape/.test(lastKey.out), pressed.all.slice(0, 200) + " / " + lastKey.all.slice(0, 200));

  const evald = await cast(["browser", "eval", "--real", "document.title"]);
  check("eval", evald.code === 0 && /Cast Bridge Smoke/.test(evald.out), evald.all.slice(0, 200));

  const shotOut = path.join(work, "smoke-shot.png");
  const shot = await cast(["browser", "shot", "--real", "--out", shotOut]);
  const shotOk = shot.code === 0 && fs.existsSync(shotOut) && fs.statSync(shotOut).size > 1024;
  check("shot", shotOk, shot.all.slice(0, 300));

  const tabs = await cast(["browser", "tabs", "--real"]);
  check("tabs", tabs.code === 0 && tabs.all.includes(pageUrl.slice(0, 30)), tabs.all.slice(0, 300));

  // 7. Groups, the working indicator and the border overlay, as a raw CDP client.
  await bridgeExtras(bridgePort, token, ext, cdpPort, pageUrl);
  await ext.close();

  // 8. The engine, driving the SAME real Chrome through the same host, as a
  //    plain CDP client: this is what `cast browser --real` does once the
  //    engine adapter appends `--cdp <url>` (see bridge/real.ts realCdpUrl).
  const ab = findEngine();
  if (!ab) {
    console.log("SKIP  engine (agent-browser) — no binary found; set SMOKE_ENGINE=/path/to/agent-browser");
    return;
  }
  const cdpUrl = `ws://127.0.0.1:${bridgePort}/devtools/browser/${token}`;
  const eOpen = await engine(ab, ["--cdp", cdpUrl, "open", pageUrl]);
  check("engine: open via --cdp", eOpen.code === 0 && /Cast Bridge Smoke/.test(eOpen.all), eOpen.all.slice(0, 300));

  const eSnap = await engine(ab, ["--cdp", cdpUrl, "snapshot"]);
  const eBtn = (eSnap.all.match(/button "Sign in" \[ref=(e\d+)\]/) || [])[1];
  check("engine: snapshot", eSnap.code === 0 && !!eBtn && /Cast Bridge Smoke Page/.test(eSnap.all), eSnap.all.slice(0, 300));

  const eInput = (eSnap.all.match(/textbox "Query" \[ref=(e\d+)\]/) || [])[1];
  const eFill = eInput ? await engine(ab, ["--cdp", cdpUrl, "fill", `@${eInput}`, "via engine"]) : { code: 1, all: "no input ref" };
  const eClick = eBtn ? await engine(ab, ["--cdp", cdpUrl, "click", `@${eBtn}`]) : { code: 1, all: "no button ref" };
  const eOut = await engine(ab, ["--cdp", cdpUrl, "eval", "document.getElementById('out').textContent"]);
  check(
    "engine: fill + click",
    eFill.code === 0 && eClick.code === 0 && /submitted:via engine/.test(eOut.all),
    `${eFill.all.slice(0, 120)} / ${eClick.all.slice(0, 120)} / ${eOut.all.slice(0, 120)}`,
  );

  const eShotOut = path.join(work, "engine-shot.png");
  const eShot = await engine(ab, ["--cdp", cdpUrl, "screenshot", eShotOut]);
  check("engine: screenshot", eShot.code === 0 && fs.existsSync(eShotOut) && fs.statSync(eShotOut).size > 1024, eShot.all.slice(0, 200));

  const eTabs = await engine(ab, ["--cdp", cdpUrl, "tab", "list"]);
  check("engine: tab list", eTabs.code === 0 && eTabs.all.includes(pageUrl.slice(0, 30)), eTabs.all.slice(0, 300));

  await engine(ab, ["--cdp", cdpUrl, "close"]);
}

async function cleanup() {
  try {
    pageServer?.close();
  } catch {}
  try {
    chrome?.kill("SIGTERM");
  } catch {}
  try {
    const bridge = JSON.parse(fs.readFileSync(path.join(castDir, "browser", "bridge.json"), "utf-8"));
    if (bridge.hostPid) process.kill(bridge.hostPid, "SIGTERM");
  } catch {}
  if (process.env.SMOKE_KEEP) {
    console.log(`SMOKE_KEEP set — leaving ${work} in place`);
    return;
  }
  // Chrome keeps writing its profile for a moment after SIGTERM; racing it
  // makes rm report half-deleted directories.
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      execSync(`rm -rf ${JSON.stringify(work)} 2>/dev/null`);
    } catch {}
    if (!fs.existsSync(work)) return;
  }
}

try {
  await main();
} catch (err) {
  check("smoke run completed", false, String(err?.message || err));
} finally {
  await cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
