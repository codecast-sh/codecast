// Captures every figure on a documentation guide (or blog post) at its final
// animation frame, for checking figures by eye. `cast browser shot` reads the
// compositor's last frame, which a background tab stops producing, so it
// returns stale or blank frames there; a clipped Page.captureScreenshot
// renders fresh. Animations are forced to their end state with the same rules
// reduced motion uses, so a figure is judged as a reader sees it once it plays.
//
//   cast browser open http://localhost:3200/documentation/visual-canvas
//   bun packages/web/scripts/guide-figure-shots.ts                    # every figure
//   bun packages/web/scripts/guide-figure-shots.ts 2                  # just the 2nd
//   bun packages/web/scripts/guide-figure-shots.ts visual-canvas 2    # the tab on this slug
//
//   bun packages/web/scripts/guide-figure-shots.ts visual-canvas --phone  # at 390px wide
//
// Name the slug when other sessions have guide tabs open too: without it the
// first guide tab on the bridge wins, which may be someone else's.
//
// Writes /tmp/guide-figure-shots/<slug>-<n>.png and prints the paths.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CdpConnection, listTargetsVia } from "../../cli/src/browser/cdp";
import { readBridgeState } from "../../cli/src/browser/bridge/host";
import { bridgeEndpointIfConfigured } from "../../cli/src/browser/bridge/real";

const OUT_DIR = "/tmp/guide-figure-shots";
const phone = process.argv.includes("--phone");
const args = process.argv.slice(2).filter((a) => a !== "--phone");
const wantSlug = args.find((a) => !/^\d+$/.test(a));
const only = args.find((a) => /^\d+$/.test(a)) ? Number(args.find((a) => /^\d+$/.test(a))) : null;
const isArticle = (url: string) => {
  const m = /\/(documentation|blog)\/([^/?#]+)/.exec(url);
  return !!m && (!wantSlug || m[2] === wantSlug);
};

const FINAL_FRAME = `(() => {
  const s = document.createElement("style");
  s.textContent = "[data-play] *{animation:none!important;transition:none!important}"
    + ".bj-draw{stroke-dashoffset:0!important}.bj-pop,.bj-fade,.bj-rise{opacity:1!important;transform:none!important}.bj-sweep{opacity:0!important}.bj-grow{transform:none!important}";
  document.head.appendChild(s);
  // A background tab never starts a lazy image; load every screenshot now.
  document.querySelectorAll("article img[loading=lazy]").forEach((i) => { i.loading = "eager"; });
  return document.querySelectorAll("article figure").length;
})()`;

/** Scroll figure i into view and return its box in document coordinates. */
const FIGURE_BOX = (i: number) => `(async () => {
  const f = document.querySelectorAll("article figure")[${i}];
  f.scrollIntoView({ block: "center" });
  await new Promise((r) => setTimeout(r, 1200));
  // A lazy screenshot has no height until it loads; measure after it does.
  await Promise.all([...f.querySelectorAll("img")].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 15000); })));
  const r = f.getBoundingClientRect();
  return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
})()`;


const tabs = readBridgeState()?.sessionTabs ?? {};
const session = Object.keys(tabs).find((k) => tabs[k].some((t) => isArticle(t.url)));
if (!session) throw new Error("no cast browser tab on a guide or post: cast browser open <url> first");
const ep = await bridgeEndpointIfConfigured(session);
if (!ep) throw new Error("the cast browser bridge is not running: check cast browser extension status");

const conn = await CdpConnection.fromPort(ep);
let attached: string | undefined;
try {
  const target = (await listTargetsVia(conn)).find((t) => isArticle(t.url));
  if (!target) throw new Error("the guide tab is not visible to this session");
  const slug = new URL(target.url).pathname.split("/").filter(Boolean).pop() ?? "page";
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  attached = sessionId;
  const evaluate = async <T>(expression: string) =>
    (await conn.send<{ result: { value: T } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;

  // Reload so the capture reflects the files on disk, then wait for the page
  // and its lazy figures, which take a while under load.
  if (phone) await conn.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  else await conn.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  await conn.send("Page.reload", { ignoreCache: true }, sessionId);
  await Bun.sleep(3000);
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate<boolean>(`document.querySelectorAll("article figure").length > 0 && !document.querySelector("article figure .h-64")`);
    if (ready) break;
    await Bun.sleep(2000);
  }
  await Bun.sleep(1500);
  const count = await evaluate<number>(FINAL_FRAME);
  mkdirSync(OUT_DIR, { recursive: true });
  for (let i = 0; i < count; i++) {
    if (only !== null && only !== i + 1) continue;
    const clip = await evaluate<{ x: number; y: number; width: number; height: number }>(FIGURE_BOX(i));
    const { data } = await conn.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", clip: { ...clip, scale: 1 }, captureBeyondViewport: true },
      sessionId,
      60_000,
    );
    const out = join(OUT_DIR, `${slug}-${i + 1}${phone ? "-phone" : ""}.png`);
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log(out);
  }
  if (count === 0) console.log("no <figure> in the article");
} finally {
  if (phone && attached) await conn.send("Emulation.clearDeviceMetricsOverride", {}, attached).catch(() => {});
  conn.close();
}
