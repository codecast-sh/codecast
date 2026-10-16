// Renders the App Store screenshots: each SHOTS entry (shots.js) composed by
// frame.html over the app's own screen (raw/<device>-<screen>.png), captured
// at 2x through this session's cast browser tab over the bridge, the way
// packages/web/scripts/readme-shots.ts captures the README shots.
//
//   bun packages/web/scripts/store-shots.ts                 # every shot, iPhone and iPad
//   bun packages/web/scripts/store-shots.ts inbox huddle    # just these
//   DEVICES=iphone bun packages/web/scripts/store-shots.ts  # one device
//
// Output: packages/mobile/store-shots/out/<device>-<n>-<shot>.png, at the
// store's exact sizes (iPhone 6.9" 1320x2868, iPad 13" 2064x2752).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CdpConnection, listTargetsVia } from "../../cli/src/browser/cdp";
import { readBridgeState } from "../../cli/src/browser/bridge/host";
import { bridgeEndpointIfConfigured } from "../../cli/src/browser/bridge/real";
// @ts-expect-error plain JS module shared with frame.html
import { SHOTS } from "../../mobile/store-shots/shots.js";

const ROOT = join(import.meta.dir, "..", "..", "mobile");
const OUT = join(ROOT, "store-shots", "out");
const PORT = 8731;
const SIZES = { iphone: { w: 660, h: 1434 }, ipad: { w: 1032, h: 1376 } } as const;
type Device = keyof typeof SIZES;

const names = process.argv.slice(2);
const wanted: string[] = names.length ? names : Object.keys(SHOTS);
for (const n of wanted) if (!(n in SHOTS)) throw new Error(`unknown shot "${n}"; known: ${Object.keys(SHOTS).join(", ")}`);
const devices = (process.env.DEVICES?.split(",") ?? ["iphone", "ipad"]) as Device[];

// The page loads fonts from ../assets and screens from raw/, so serve the whole mobile package.
const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.includes("..")) return new Response("no", { status: 400 });
    const file = Bun.file(join(ROOT, path));
    return file.exists().then((ok) => (ok ? new Response(file, { headers: { "cache-control": "no-store" } }) : new Response("missing", { status: 404 })));
  },
});
const base = `http://localhost:${PORT}/store-shots/frame.html`;

try {
  // Async: a sync spawn would block this process's event loop, and with it
  // the server the tab is loading from.
  await Bun.spawn(["cast", "browser", "open", `${base}?shot=${wanted[0]}`], { stdout: "ignore", stderr: "ignore" }).exited;
  const tabs = readBridgeState()?.sessionTabs ?? {};
  const session = Object.keys(tabs).find((k) => tabs[k].some((t) => t.url.startsWith(base)));
  if (!session) throw new Error("no cast browser tab on the frame page");
  const ep = await bridgeEndpointIfConfigured(session);
  if (!ep) throw new Error("the cast browser bridge is not running: check cast browser extension status");

  const conn = await CdpConnection.fromPort(ep);
  try {
    const target = (await listTargetsVia(conn)).find((t) => t.url.startsWith(base));
    if (!target) throw new Error("the frame tab is not visible to this session");
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const evaluate = async <T>(expression: string) =>
      (await conn.send<{ result: { value: T } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;

    mkdirSync(OUT, { recursive: true });
    for (const device of devices) {
      const { w, h } = SIZES[device];
      await conn.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false }, sessionId);
      // A file is numbered by its place in the device's whole set (the order
      // it uploads in), however few shots this run renders.
      const onDevice = Object.keys(SHOTS).filter((n) => !SHOTS[n].devices || SHOTS[n].devices.includes(device));
      for (const name of wanted.filter((n) => onDevice.includes(n))) {
        await conn.send("Page.navigate", { url: `${base}?shot=${name}&device=${device}&t=${Date.now()}` }, sessionId);
        const ready = await evaluate<boolean>(`new Promise((r) => { const t0 = Date.now(); (function poll() { if (document.body?.dataset.ready === "1") return r(true); if (Date.now() - t0 > 20000) return r(false); setTimeout(poll, 100); })(); })`);
        if (!ready) throw new Error(`${device}/${name}: the page never finished loading`);
        const { data } = await conn.send<{ data: string }>(
          "Page.captureScreenshot",
          { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: true },
          sessionId,
          60_000,
        );
        const index = onDevice.indexOf(name) + 1;
        const out = join(OUT, `${device}-${index}-${name}.png`);
        writeFileSync(out, Buffer.from(data, "base64"));
        const dims = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out]).toString().match(/\d+/g)?.slice(-2).join("x");
        console.log(`${device.padEnd(6)} ${name.padEnd(8)} ${dims}  ${out}`);
      }
      await conn.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
    }
  } finally {
    conn.close();
  }
} finally {
  server.stop(true);
}
