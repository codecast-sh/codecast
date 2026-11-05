// /og/card/<token>.png: a published weekly card as the image its link
// unfurls to on X, Bluesky, Reddit and Slack. Drawn from the same element the
// page renders (components/weeklyCard/WeekCardView) by satori, rasterised by
// resvg's wasm build, with the committed JetBrains Mono faces the marketing
// cards use (scripts/og-cards.mjs). The card data comes through the share
// cache, so a bot's unfurl and its image fetch cost one query.
import { createElement } from "react";
import { readFile } from "fs/promises";
import { createRequire } from "module";
import { join } from "path";
import type { Hono } from "hono";
import type { WeekCardStats } from "@codecast/shared/contracts/weeklyCard";
import { WeekCardView } from "../components/weeklyCard/WeekCardView";
import { WEEK_CARD_H, WEEK_CARD_W } from "@codecast/shared/contracts/weeklyCard";
import { fetchShared } from "./shareData";

const require = createRequire(import.meta.url);
const FONT_DIR = join(import.meta.dirname, "../scripts/og-fonts");
const TOKEN_RE = /^[A-Za-z0-9_-]{6,80}$/;

type Renderer = (el: unknown) => Promise<Uint8Array>;
let rendererPromise: Promise<Renderer> | null = null;

function renderer(): Promise<Renderer> {
  rendererPromise ??= (async () => {
    const [{ default: satori }, resvg] = await Promise.all([import("satori"), import("@resvg/resvg-wasm")]);
    await resvg.initWasm(await readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
    const fonts = await Promise.all(
      ([400, 700] as const).map(async (weight) => ({
        name: "JetBrains Mono",
        weight,
        style: "normal" as const,
        data: await readFile(join(FONT_DIR, `JetBrainsMono-${weight}.ttf`)),
      })),
    );
    return async (el: unknown) => {
      const svg = await satori(el as any, { width: WEEK_CARD_W, height: WEEK_CARD_H, fonts });
      return new resvg.Resvg(svg, { fitTo: { mode: "width", value: WEEK_CARD_W } }).render().asPng();
    };
  })();
  // A failed load (no wasm in this build) is retried on the next request, not cached.
  rendererPromise.catch(() => { rendererPromise = null; });
  return rendererPromise;
}

/** The PNG for a published card, or null when the token is closed. */
export async function weekCardPng(token: string): Promise<Uint8Array | null> {
  const result = await fetchShared("card", token);
  const data = result?.value as { stats: WeekCardStats; user: { name: string | null } | null } | null | undefined;
  if (!data) return null;
  const render = await renderer();
  return await render(createElement(WeekCardView, { stats: data.stats, name: data.user?.name ?? null }));
}

export function registerWeekCardImage(app: Hono) {
  app.get("/og/card/:file", async (c) => {
    const token = (c.req.param("file") ?? "").replace(/\.png$/, "");
    if (!TOKEN_RE.test(token)) return c.text("Not found", 404);
    try {
      const png = await weekCardPng(token);
      if (!png) return c.text("Not found", 404);
      c.header("Content-Type", "image/png");
      // The page's own cache rule: unpublishing reaches the edge within a minute.
      c.header("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
      return c.body(png as any);
    } catch (err) {
      console.error("[og] weekly card image failed", err);
      return c.redirect("/logo-final.png", 302);
    }
  });
}
