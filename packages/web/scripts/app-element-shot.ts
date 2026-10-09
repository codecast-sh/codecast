// Captures one element of a live app page at 2x, for documentation
// screenshots of a single surface (a dialog, a conversation column, a card).
// Clipping to the element keeps the rest of a real workspace (the sidebar,
// other sessions) out of a public image. `cast browser shot` reads the
// compositor's last frame, which a background tab stops producing; a clipped
// Page.captureScreenshot renders fresh.
//
//   cast browser open "https://codecast.sh/agent-features?feature=computer"
//   bun packages/web/scripts/app-element-shot.ts <url-part> '<css selector>' out.png [--js '<expression>'] [--pad 16]
//
// <url-part> picks this session's tab whose URL contains it. --js runs first
// (open a menu, hide a row) and may return a promise. Look at every capture
// before keeping it.

import { writeFileSync } from "node:fs";
import { CdpConnection, listTargetsVia } from "../../cli/src/browser/cdp";
import { readBridgeState } from "../../cli/src/browser/bridge/host";
import { bridgeEndpointIfConfigured } from "../../cli/src/browser/bridge/real";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = argv.splice(i, 2);
  return value;
};
const js = flag("--js");
const pad = Number(flag("--pad") ?? 0);
const [urlPart, selector, out] = argv;
if (!urlPart || !selector || !out) throw new Error("usage: app-element-shot.ts <url-part> <selector> <out.png> [--js <expr>] [--pad n]");

const tabs = readBridgeState()?.sessionTabs ?? {};
const session = Object.keys(tabs).find((k) => tabs[k].some((t) => t.url.includes(urlPart)));
if (!session) throw new Error(`no cast browser tab whose URL contains "${urlPart}"`);
const ep = await bridgeEndpointIfConfigured(session);
if (!ep) throw new Error("the cast browser bridge is not running: check cast browser extension status");

const conn = await CdpConnection.fromPort(ep);
try {
  const target = (await listTargetsVia(conn)).find((t) => t.url.includes(urlPart));
  if (!target) throw new Error("that tab is not visible to this session");
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const evaluate = async <T>(expression: string) => {
    const res = await conn.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, 60_000);
    if (res.exceptionDetails) throw new Error(`page threw: ${res.exceptionDetails.text}`);
    return res.result.value;
  };

  if (js) await evaluate(js);
  const box = await evaluate<{ x: number; y: number; width: number; height: number } | null>(`(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    await new Promise((r) => setTimeout(r, 600));
    const r = el.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  })()`);
  if (!box) throw new Error(`no element matches ${selector}`);
  const clip = { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad, scale: 2 };
  const { data } = await conn.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true }, sessionId, 60_000);
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`${out}  ${Math.round(box.width)}x${Math.round(box.height)} css px`);
} finally {
  conn.close();
}
