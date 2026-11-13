// Captures the docs images in packages/web/docs-shots/manifest.ts from the
// docs shots server (lib/docsShots: the real app over the Acme fixture world,
// no server, no account), at 2x, frames each through docs-shots/frame.html
// and writes .webp. Nothing from a real workspace can reach these images: the
// server's origin has never signed in to one.
//
//   bun packages/web/scripts/docs-shots.ts                   every shot
//   bun packages/web/scripts/docs-shots.ts inbox palette     just these (by name)
//   bun packages/web/scripts/docs-shots.ts --batch machines  one batch file (docs-shots/batches)
//   bun packages/web/scripts/docs-shots.ts --raw-only        skip framing and webp; print the raw PNGs
//
// It starts (or reuses) the server with scripts/docs-shots-dev.sh and drives
// this session's own cast browser tab on it, opening one if there is none, so
// parallel runs from different sessions never share a tab. The app loads
// once; each shot moves to its route inside the app, so a shot costs seconds,
// not a boot. A dev server reload mid-shot (anyone's edit) retries the shot.
// Look at every image before keeping it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SHOTS, type Shot, type Step } from "../docs-shots/manifest";
import { attachCastTab, type CastTab } from "./castTab";

const WEB = resolve(import.meta.dir, "..");
const REPO = resolve(WEB, "../..");
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const APP_SHELL = "[data-cc-shell]";
const BOOTED = `window.__docsShots?.ready && window.__inboxStore && document.querySelector(${JSON.stringify(APP_SHELL)})`;

const args = process.argv.slice(2);
const rawOnly = args.includes("--raw-only");
const batchAt = args.indexOf("--batch");
const batch = batchAt >= 0 ? args.splice(batchAt, 2)[1] : undefined;
const names = args.filter((a) => !a.startsWith("--"));
for (const n of names) if (!SHOTS.some((s) => s.name === n)) throw new Error(`unknown shot "${n}"; known: ${SHOTS.map((s) => s.name).join(", ")}`);
if (batch && !SHOTS.some((s) => s.batch === batch)) throw new Error(`no shots in batch "${batch}"`);
const wanted = SHOTS.filter((s) => (!names.length || names.includes(s.name)) && (!batch || s.batch === batch));
const dupes = SHOTS.map((s) => s.name).filter((n, i, all) => all.indexOf(n) !== i);
if (dupes.length) throw new Error(`shot names must be unique: ${[...new Set(dupes)].join(", ")}`);
/** A shot's file stem in the scratch dir and the frame server (names may hold "/"). */
const stem = (shot: Shot) => shot.name.replace(/[^a-zA-Z0-9_-]+/g, "__");
for (const s of wanted) {
  if (s.frame === "none" && s.out.startsWith("public/docs/")) throw new Error(`${s.name}: images under public/docs are shown bare, so they must be framed (window, element or phone)`);
  if (!s.route && !s.raw) throw new Error(`${s.name}: needs a route or a raw capture`);
}

const origin = execFileSync(join(WEB, "scripts/docs-shots-dev.sh"), { encoding: "utf-8" }).trim().replace("localhost", "127.0.0.1");
const scratch = mkdtempSync(join(tmpdir(), "docs-shots-"));

async function tabOn(prefix: string, url: string): Promise<CastTab> {
  try {
    return await attachCastTab((u) => u.startsWith(prefix), prefix, { ownOnly: true });
  } catch {
    execFileSync("cast", ["browser", "open", url], { stdio: "ignore" });
    return attachCastTab((u) => u.startsWith(prefix), prefix, { ownOnly: true });
  }
}

async function until(tab: CastTab, expression: string, what: string, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await tab.evaluate<boolean>(`!!(${expression})`).catch(() => false)) return;
    await Bun.sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
async function press(tab: CastTab, chord: string) {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const modifiers = parts.reduce((m, p) => m | (MODIFIERS[p] ?? 0), 0);
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Escape: 27, Enter: 13 } as Record<string, number>)[key] ?? 0;
  for (const type of ["keyDown", "keyUp"]) {
    await tab.send("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  }
}

/** The first element matching `selector` (and containing `text`, when given), as page JS. */
const find = (selector: string, text?: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : "true"})`;

/** A real pointer event at the element's center: hover cards, menus and context menus need one, not el.click(). */
async function pointer(tab: CastTab, selector: string, text: string | undefined, kind: "hover" | "left" | "right") {
  const at = await tab.evaluate<{ x: number; y: number } | null>(`(() => { const e = ${find(selector, text)}; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`no element matches ${selector}${text ? ` containing "${text}"` : ""}`);
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  if (kind === "hover") return;
  const button = kind === "right" ? "right" : "left";
  await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, ...at });
  await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, ...at });
}

async function runStep(tab: CastTab, step: Step) {
  if ("js" in step) await tab.evaluate(step.js);
  else if ("click" in step) await pointer(tab, step.click, step.text, "left");
  else if ("rightClick" in step) await pointer(tab, step.rightClick, step.text, "right");
  else if ("hover" in step) await pointer(tab, step.hover, step.text, "hover");
  else if ("type" in step) await tab.send("Input.insertText", { text: step.type });
  else if ("key" in step) await press(tab, step.key);
  else if ("wait" in step) await until(tab, find(step.wait, step.text), step.wait, 30_000);
  else await Bun.sleep(step.sleep);
}

/** The box to capture in CSS px, once it holds still (an opening animation). */
const boxOf = (selector: string | null) => `(async () => {
  const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "null"};
  if (${selector ? "!el" : "false"}) return null;
  let last = "";
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const r = el ? el.getBoundingClientRect() : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const box = JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    if (box === last) return JSON.parse(box);
    last = box;
  }
  return JSON.parse(last);
})()`;

async function captureApp(tab: CastTab, shot: Shot): Promise<string> {
  const vp = shot.viewport ?? DEFAULT_VIEWPORT;
  const theme = shot.theme ?? "light";
  // A dev server reload (an edit to the app) reboots the page between shots.
  await until(tab, BOOTED, "the docs shots app to boot", 300_000);
  await tab.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: false });
  // Close whatever the last shot opened, then move inside the app: no reload.
  await press(tab, "Escape");
  await tab.evaluate(`(async () => {
    const st = __inboxStore.getState();
    st.closePalette?.();
    if (st.clientState.ui?.theme !== ${JSON.stringify(theme)}) st.updateClientUI({ theme: ${JSON.stringify(theme)} });
    // The session rail shows only where the shot asks for it.
    if (${!!shot.rail}) { if (!document.querySelector("[data-sv-rail]")) st.toggleSidePanel(); }
    else st.closeSidePanel();
    history.pushState(null, "", ${JSON.stringify(shot.route)});
    dispatchEvent(new PopStateEvent("popstate"));
  })()`);
  await until(tab, `location.pathname === ${JSON.stringify(shot.route!.split("?")[0])} && innerWidth === ${vp.width}`, `${shot.name}: the route and viewport`);
  const selector = shot.crop && shot.crop !== "window" ? shot.crop.selector : null;
  const ready = shot.ready ?? (shot.steps?.length ? APP_SHELL : selector ?? APP_SHELL);
  await until(tab, `document.querySelector(${JSON.stringify(ready)})`, `${shot.name}: ${ready}`, 60_000);
  // A lazy route shows the app loader until its chunk lands, slow on a loaded machine.
  await until(tab, `!document.querySelector(".app-loader")`, `${shot.name}: the route's code`, 120_000);
  for (const step of shot.steps ?? []) await runStep(tab, step);
  // Let images and fonts land, and clear toasts nothing in the shot asked for.
  await tab.evaluate(`document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 1200))).then(() => window.__toast?.dismiss())`);
  await Bun.sleep(400);
  const box = await tab.evaluate<{ x: number; y: number; width: number; height: number } | null>(boxOf(selector));
  if (!box) throw new Error(`${shot.name}: no element matches ${selector}`);
  const pad = shot.crop && shot.crop !== "window" ? shot.crop.pad ?? 0 : 0;
  const clip = { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad, scale: 1 };
  const { data } = await tab.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip });
  const out = join(scratch, `${stem(shot)}.png`);
  writeFileSync(out, Buffer.from(data, "base64"));
  return out;
}

/** A capture survives a dev server reload under it (another session's edit) by starting over. */
async function captureWithRetry(tab: CastTab, shot: Shot): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await captureApp(tab, shot);
    } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`retry    ${shot.name}: ${(e as Error).message.split("\n")[0]}`);
      await Bun.sleep(2000);
    }
  }
}

/** Serves packages/ (frame.html loads ../../mobile/assets fonts) and the raw captures under /__raw/. */
function frameServer(raws: Map<string, string>) {
  const root = resolve(WEB, "..");
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const raw = path.startsWith("/__raw/") ? raws.get(path.slice(7).replace(/\.png$/, "")) : undefined;
      const file = raw ?? resolve(root, `.${path}`);
      if (!file.startsWith(root) && !raw) return new Response("outside packages/", { status: 403 });
      return existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
    },
  });
}

async function frame(tab: CastTab, base: string, shot: Shot): Promise<Buffer> {
  const q = new URLSearchParams({ src: `${base}/__raw/${stem(shot)}.png`, kind: shot.frame, theme: shot.theme ?? "light" });
  if (shot.title) q.set("title", shot.title);
  const url = `${base}/web/docs-shots/frame.html?${q}`;
  await tab.send("Page.navigate", { url });
  // The last frame page also says ready until this one replaces it.
  await until(tab, `location.href === ${JSON.stringify(url)} && (document.body?.dataset.ready === "1" || document.body?.dataset.ready === "error")`, `${shot.name}: the frame page`, 30_000);
  const size = await tab.evaluate<{ ready: string; w: number; h: number }>(`({ ready: document.body.dataset.ready, w: Number(document.body.dataset.w), h: Number(document.body.dataset.h) })`);
  if (size.ready !== "1") throw new Error(`${shot.name}: the frame page could not load the raw capture`);
  await tab.send("Emulation.setDeviceMetricsOverride", { width: Math.max(size.w, 400), height: Math.max(size.h, 400), deviceScaleFactor: 2, mobile: false });
  await tab.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const { data } = await tab.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 }, captureBeyondViewport: true });
  return Buffer.from(data, "base64");
}

const raws = new Map<string, string>();
// One tab does everything: the app's shots, then each frame page.
const tab = await tabOn(origin, `${origin}/inbox`);
try {
  const rendered = wanted.filter((s) => s.route);
  if (rendered.length) {
    // A fresh tab boots the app; under load that takes a while.
    await until(tab, BOOTED, "the docs shots app to boot", 300_000);
    for (const shot of rendered) {
      raws.set(stem(shot), await captureWithRetry(tab, shot));
      console.log(`captured ${shot.name.padEnd(28)} ${raws.get(stem(shot))}`);
    }
  }
  for (const shot of wanted.filter((s) => s.raw)) {
    const file = resolve(REPO, shot.raw!);
    if (!existsSync(file)) {
      console.warn(`skipped  ${shot.name.padEnd(28)} no raw capture at ${shot.raw} yet`);
      continue;
    }
    raws.set(stem(shot), file);
  }
  if (!rawOnly) await frameAll(tab);
} finally {
  await tab.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await tab.send("Emulation.setDefaultBackgroundColorOverride", {}).catch(() => {});
  tab.close();
}

async function frameAll(tab: CastTab) {
  const server = frameServer(raws);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const shot of wanted) {
      const raw = raws.get(stem(shot));
      if (!raw) continue;
      const png = shot.frame === "none" ? readFileSync(raw) : await frame(tab, base, shot);
      const framed = join(scratch, `${stem(shot)}.framed.png`);
      writeFileSync(framed, png);
      const out = join(WEB, shot.out);
      mkdirSync(dirname(out), { recursive: true });
      execFileSync("cwebp", ["-quiet", "-q", String(shot.quality ?? 88), "-m", "6", "-alpha_q", "100", framed, "-o", out]);
      console.log(`wrote    ${shot.name.padEnd(28)} ${shot.out}`);
    }
  } finally {
    server.stop(true);
  }
}
