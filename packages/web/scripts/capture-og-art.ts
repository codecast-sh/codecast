#!/usr/bin/env bun
/**
 * Captures the hero visual of every /features/<slug> page into
 * scripts/og-art/<slug>.jpg, the picture scripts/og-cards.mjs puts on that
 * page's social card. Each page marks its visual with `data-og-art`; the page
 * opens with `?static`, so animated heroes show their finished frame.
 *
 * Rerun after a hero changes and commit the images (the build never captures:
 * Railway has no browser). Drives this session's cast browser tab.
 *
 * `--webp` instead writes the JPEG copy of every WebP picture a card names
 * (lib/seoRoutes.ts cardArt), since the card renderer reads PNG and JPEG only.
 *
 *   bun scripts/capture-og-art.ts [--base http://localhost:3201] [slug ...]
 *   bun scripts/capture-og-art.ts --webp
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_DEEP_DIVES } from "../app/(marketing)/features/catalog";
import { SEO_ROUTES } from "../lib/seoRoutes";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "og-art");
/** Long edge of a stored image: twice the card's art area, so it stays sharp. */
const MAX_EDGE = 1600;

const WEB = join(OUT, "..", "..");
const args = process.argv.slice(2);
const baseAt = args.indexOf("--base");
const base = baseAt >= 0 ? args.splice(baseAt, 2)[1] : "http://localhost:3201";
const slugs = args.length > 0 ? args : FEATURE_DEEP_DIVES.map((f) => f.slug);

function run(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${p.stderr.toString().trim() || p.stdout.toString().trim()}`);
  return p.stdout.toString().trim();
}

// Marks the first visible [data-og-art] for the screenshot, scrolled into
// view; answers "wait" while the page is still loading.
const MARK = `(() => {
  const el = [...document.querySelectorAll("[data-og-art]")].find((e) => e.getClientRects().length > 0);
  if (!el) return "wait";
  document.querySelectorAll("[data-og-capture]").forEach((e) => e.removeAttribute("data-og-capture"));
  el.setAttribute("data-og-capture", "");
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return Math.round(r.width) + "x" + Math.round(r.height);
})()`;

/** Marks the visual, polling for up to five minutes (a cold dev server is slow). */
async function mark(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const out = run(["cast", "browser", "eval", MARK]).split("\n").pop() ?? "";
    if (out !== "wait") {
      await Bun.sleep(1500); // fonts and the scroll settle
      return out;
    }
    await Bun.sleep(5000);
  }
  throw new Error("no visible [data-og-art] after five minutes");
}

if (args[0] === "--webp") {
  const copies = new Set(SEO_ROUTES.map((e) => e.card?.art).filter((a): a is string => !!a?.startsWith("scripts/og-art/webp/")));
  for (const copy of copies) {
    const source = join(WEB, "public", copy.slice("scripts/og-art/webp/".length).replace(/\.jpg$/, ".webp"));
    const out = join(WEB, copy);
    if (existsSync(out)) continue;
    mkdirSync(dirname(out), { recursive: true });
    run(["sips", "-Z", String(MAX_EDGE), "-s", "format", "jpeg", "-s", "formatOptions", "86", source, "--out", out]);
    console.log(`${copy} <- ${source}`);
  }
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const slug of slugs) {
  try {
    run(["cast", "browser", "open", "--deadline", "240", `${base}/features/${slug}?static`]);
    const size = await mark();
    const png = join(OUT, `${slug}.png`);
    run(["cast", "browser", "shot", "-s", "[data-og-capture]", "--no-inline", "-o", png]);
    const jpg = join(OUT, `${slug}.jpg`);
    run(["sips", "-Z", String(MAX_EDGE), "-s", "format", "jpeg", "-s", "formatOptions", "86", png, "--out", jpg]);
    rmSync(png);
    console.log(`${slug}: ${size} -> ${jpg}`);
  } catch (err) {
    failed++;
    console.error(`${slug}: FAILED ${(err as Error).message}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
