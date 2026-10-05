// Captures the README and docs screenshots (docs/screenshots/*.png) from the
// homepage's product film, which renders the real product views over fixture
// data only, so nothing from a real workspace reaches a public image. The
// shot list and how to pick a film time are in docs/screenshots/CAPTURE.md.
//
// It drives this session's own cast browser tab through the bridge, at 2x:
// `cast browser shot` captures at 1x. Open the tab first, then run from the
// repo root:
//
//   cast browser open "https://codecast.sh/?hero-t=6.6"
//   bun packages/web/scripts/readme-shots.ts            # every shot
//   bun packages/web/scripts/readme-shots.ts inbox pr   # just these
//
// Look at every capture before keeping it: a time between two chapter holds
// catches windows mid-fade.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpConnection, listTargetsVia } from "../../cli/src/browser/cdp";
import { readBridgeState } from "../../cli/src/browser/bridge/host";
import { bridgeEndpointIfConfigured } from "../../cli/src/browser/bridge/real";

/** File name → film time, inside that chapter's hold (heroFly/world.ts CHAPTERS). */
const SHOTS: Record<string, number> = {
  hero: 40.7,
  inbox: 6.6,
  conversation: 11.5,
  fanout: 18,
  "mobile-chat": 27,
  "session-messages": 33.5,
  tasks: 46.5,
  automations: 53.3,
  "team-chat": 58.5,
  "pull-request": 65.5,
  pages: 72.5,
  "command-palette": 77.5,
  blame: 80.7,
};
const OUT_DIR = join(import.meta.dir, "..", "..", "..", "docs", "screenshots");
const OUT_WIDTH = 1920;
const SETTLE_MS = 9000;

// Lift the film out of the page's column so it lays out at its native 1280x760
// stage with no scale, then report where it sits in document coordinates.
const WIDEN = `(async () => {
  const fig = document.querySelector('figure[aria-label="Codecast product tour"]');
  for (let n = fig; n && n !== document.body; n = n.parentElement) n.style.maxWidth = "none";
  fig.style.width = "1280px";
  fig.style.margin = "0 auto";
  await new Promise((r) => setTimeout(r, 1500));
  const box = document.querySelector(".hf-box");
  box.scrollIntoView({ block: "center" });
  await new Promise((r) => setTimeout(r, 1500));
  const r = box.getBoundingClientRect();
  return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
})()`;

const DISMISS_HANDOFF = `Array.from(document.querySelectorAll("button")).find((b) => /open in browser/i.test(b.textContent))?.click(); true`;

const names = process.argv.slice(2);
const wanted = names.length ? names : Object.keys(SHOTS);
for (const n of wanted) if (!(n in SHOTS)) throw new Error(`unknown shot "${n}"; known: ${Object.keys(SHOTS).join(", ")}`);

// The bridge lists only the tabs granted to a session key, so find the key
// whose tab is on the film.
const tabs = readBridgeState()?.sessionTabs ?? {};
const session = Object.keys(tabs).find((k) => tabs[k].some((t) => t.url.startsWith("https://codecast.sh/?hero-t=")));
if (!session) throw new Error('no cast browser tab on the film: run cast browser open "https://codecast.sh/?hero-t=6.6" first');
const ep = await bridgeEndpointIfConfigured(session);
if (!ep) throw new Error("the cast browser bridge is not running: check cast browser extension status");

const conn = await CdpConnection.fromPort(ep);
try {
  const target = (await listTargetsVia(conn)).find((t) => t.url.startsWith("https://codecast.sh/?hero-t="));
  if (!target) throw new Error("the film tab is not visible to this session");
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const evaluate = async <T>(expression: string) =>
    (await conn.send<{ result: { value: T } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;

  const scratch = mkdtempSync(join(tmpdir(), "readme-shots-"));
  for (const name of wanted) {
    await conn.send("Page.navigate", { url: `https://codecast.sh/?hero-t=${SHOTS[name]}` }, sessionId);
    await Bun.sleep(SETTLE_MS);
    await evaluate(DISMISS_HANDOFF);
    await Bun.sleep(1500);
    const clip = await evaluate<{ x: number; y: number; width: number; height: number }>(WIDEN);
    const { data } = await conn.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } }, sessionId, 60_000);
    const raw = join(scratch, `${name}.png`);
    writeFileSync(raw, Buffer.from(data, "base64"));
    const out = join(OUT_DIR, `${name}.png`);
    execFileSync("sips", ["--resampleWidth", String(OUT_WIDTH), raw, "--out", out], { stdio: "ignore" });
    console.log(`${name.padEnd(18)} hero-t=${SHOTS[name]}  ${out}`);
  }
} finally {
  conn.close();
}
