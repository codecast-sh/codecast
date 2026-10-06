import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { HtmlTagDescriptor, ResolvedConfig } from "vite";
import { PALETTE } from "../../../platform/packages/design/src/tokens";
import { LANE_BOOT_TITLE, isLanePath } from "../components/simple/laneBoot";
import { laneBootPlugin } from "./laneBoot";

describe("lane paths", () => {
  test("/welcome and nothing that merely starts with its name; the retired lane boots as the main app it redirects into", () => {
    for (const p of ["/welcome", "/welcome/", "/welcome/x"]) expect(isLanePath(p)).toBe(true);
    for (const p of ["/", "/inbox", "/simple", "/simple/c/abc", "/welcomes", "/settings/simple"]) expect(isLanePath(p)).toBe(false);
  });
});

async function headTags(): Promise<HtmlTagDescriptor[]> {
  const plugin = laneBootPlugin();
  (plugin.configResolved as (c: ResolvedConfig) => void)({ root: path.resolve(import.meta.dir, "..") } as ResolvedConfig);
  const hook = plugin.transformIndexHtml as { handler: (html: string, ctx: unknown) => Promise<HtmlTagDescriptor[]> };
  return hook.handler("", {});
}

describe("lane boot head", () => {
  test("carries the family sheet, so the boot screen paints the shared paper in both themes", async () => {
    const style = (await headTags()).find((t) => t.tag === "style");
    expect(String(style?.children)).toContain(`--pd-bg: ${PALETTE.light.bg};`);
    expect(String(style?.children)).toContain(`--pd-bg: ${PALETTE.dark.bg};`);
  });

  test("its inline script flags <html data-lane> and drops the marketing title on a lane path only", async () => {
    const script = String((await headTags()).find((t) => t.tag === "script")?.children);
    const marketing = "Codecast: the workspace for teams and their AI coding agents";
    const run = (pathname: string) => {
      const attrs: Record<string, string> = {};
      const document = { title: marketing, documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } };
      new Function("location", "document", script)({ pathname }, document);
      return { lane: "data-lane" in attrs, title: document.title };
    };
    expect(run("/simple/approvals")).toEqual({ lane: false, title: marketing });
    expect(run("/welcome")).toEqual({ lane: true, title: LANE_BOOT_TITLE });
    expect(run("/inbox")).toEqual({ lane: false, title: marketing });
  });
});
