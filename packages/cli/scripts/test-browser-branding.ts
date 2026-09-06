import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { CdpConnection } from "../src/browser/cdp.js";

assert.equal(process.platform, "darwin");
const binary = path.resolve(process.argv[2] || "");
assert.ok(fs.statSync(binary).isFile(), "Pass the compiled CLI binary");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-branding-e2e-")));
const env = { ...process.env, CODECAST_DIR: root, CODECAST_CHROMIUM: "", CODECAST_NO_AUTO_UPDATE: "1", AGENT_BROWSER_SOCKET_DIR: path.join(root, "sockets") };
const source = "/Applications/Google Chrome.app";
const sourceInfo = fs.readFileSync(path.join(source, "Contents/Info.plist"));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response('<!doctype html><title>Cast browser verification</title><h1>Cast Agent Chrome</h1><button id="save">Save test session</button><output id="result"></output><script>save.onclick=()=>{localStorage.setItem("cast-test","saved");document.cookie="cast-test=saved; max-age=3600; path=/";result.textContent="Session saved"}</script>', { headers: { "content-type": "text/html" } }),
});
let state: { pid: number; port: number; userDataDir: string } | undefined;
let conn: CdpConnection | undefined;
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 240_000, maxBuffer: 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, result.stderr || result.error?.message || `${command}: ${result.signal}`);
  return result.stdout;
};
async function start(fresh: boolean) {
  console.log(run(binary, ["browser", "start", ...(fresh ? ["--fresh"] : [])]));
  state = JSON.parse(fs.readFileSync(path.join(root, "browser/instance.json"), "utf8"));
  assert.ok(state!.userDataDir.startsWith(`${root}/`));
  conn = await CdpConnection.fromPort(state!.port);
  const executable = run("/bin/ps", ["-p", String(state!.pid), "-o", "comm="]).trim();
  assert.ok(executable.includes(`${root}/browser/applications/version-`), executable);
  assert.ok(executable.endsWith("/Cast Agent Chrome.app/Contents/MacOS/Google Chrome"));
  const command = run("/bin/ps", ["-ww", "-p", String(state!.pid), "-o", "command="]);
  assert.ok(command.includes("--disable-updater-scheduler"));
  const app = executable.slice(0, -"/Contents/MacOS/Google Chrome".length);
  assert.deepEqual(fs.readFileSync(path.join(app, "Contents/Info.plist")), sourceInfo);
  run("/usr/bin/codesign", ["--verify", "--deep", app]);
  assert.ok(run("/usr/bin/xattr", [app]).includes("com.apple.FinderInfo"));
  const { targetId } = await conn.send("Target.createTarget", { url: server.url.href });
  const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await conn.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sessionId);
    if (value.result.value === "complete") return { app, sessionId };
    await sleep(100);
  }
  throw new Error("Verification page did not load");
}
async function stop() {
  if (!conn || !state) return;
  await Promise.allSettled([conn.send("Browser.close")]);
  conn.close();
  conn = undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnSync("/bin/ps", ["-p", String(state.pid)], { stdio: "ignore" }).status !== 0) return;
    await sleep(100);
  }
  throw new Error("Verification browser did not exit");
}
try {
  console.log(`Evidence directory: ${root}`);
  const first = await start(true);
  await conn!.send("Runtime.evaluate", { expression: 'document.getElementById("save").click()' }, first.sessionId);
  const saved = await conn!.send("Runtime.evaluate", { expression: 'document.getElementById("result").textContent', returnByValue: true }, first.sessionId);
  assert.equal(saved.result.value, "Session saved");
  const shot = await conn!.send("Page.captureScreenshot", { format: "png" }, first.sessionId);
  fs.writeFileSync(path.join(root, "browser-verification.png"), Buffer.from(shot.data, "base64"));
  await stop();
  const second = await start(false);
  assert.equal(second.app, first.app, "Restart must reuse the managed app");
  const persisted = await conn!.send("Runtime.evaluate", { expression: '({storage:localStorage.getItem("cast-test"),cookie:document.cookie})', returnByValue: true }, second.sessionId);
  assert.equal(persisted.result.value.storage, "saved");
  assert.ok(persisted.result.value.cookie.includes("cast-test=saved"));
  assert.deepEqual(fs.readFileSync(path.join(source, "Contents/Info.plist")), sourceInfo);
  console.log("PASS: compiled CLI, native copy, signatures, browser navigation, screenshot, restart, app reuse, local storage and cookies");
} finally {
  try {
    await stop();
  } finally {
    server.stop();
  }
}
