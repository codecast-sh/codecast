/**
 * Render the Chrome Web Store promo tiles from the two HTML files beside this
 * script: small (440×280) and marquee (1400×560). Needs an unbranded Chrome
 * (Chrome for Testing) for headless rendering; the PNGs it writes still carry
 * alpha, so flatten them to 24-bit for the store:
 *   bun packages/browser-extension/store/promo/render.ts
 *   python3 -c "from PIL import Image; [Image.open(f'packages/browser-extension/store/promo/{n}.png').convert('RGB').save(f'packages/browser-extension/store/promo/{o}') for n,o in (('small','small-promo-tile-440x280.png'),('marquee','marquee-promo-tile-1400x560.png'))]"
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
const CFT = "/Users/ashot/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const dir = import.meta.dir;
const prof = `/tmp/codecast-promo-prof-${Date.now()}`;
const chrome = spawn(CFT, [`--user-data-dir=${prof}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--hide-scrollbars", "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
let port = 0;
for (let i = 0; i < 100 && !port; i++) { await Bun.sleep(200); try { port = parseInt(fs.readFileSync(`${prof}/DevToolsActivePort`, "utf-8").split("\n")[0], 10); } catch {} }
if (!port) throw new Error("no port");
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map<number, (m: any) => void>();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) pend.get(m.id)!(m); };
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((r, j) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); setTimeout(() => j(new Error(method + " timed out")), 30000); });
for (const [name, w, h] of [["small", 440, 280], ["marquee", 1400, 560]] as const) {
  const ct = await send("Target.createTarget", { url: "about:blank" }); if (!ct.result) throw new Error(JSON.stringify(ct.error)); const { targetId } = ct.result;
  const { result: { sessionId: s } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.navigate", { url: `file://${dir}/tile-${name}.html` }, s);
  for (let i = 0; i < 50; i++) { await Bun.sleep(200); const r = await send("Runtime.evaluate", { expression: "document.readyState === 'complete' && document.fonts.status === 'loaded'", returnByValue: true }, s); if (r.result?.result?.value) break; }
  await Bun.sleep(500);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }, s);
  fs.writeFileSync(`${dir}/${name}.png`, Buffer.from(shot.result.data, "base64"));
  console.log("rendered", name);
}
ws.close(); chrome.kill(); process.exit(0);
