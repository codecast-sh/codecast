import { describe, expect, test } from "bun:test";
import type { OutputBundle, OutputChunk } from "rollup";
import { readFileSync } from "node:fs";
import { APP_SHELL_GLOB_IGNORES, APP_SHELL_GLOB_PATTERNS, NAVIGATION_ROUTE, SHELL_DENYLIST } from "../../vite.pwa";
import { appShellFiles, precacheScope } from "../../plugins/precacheScope";

describe("offline app shell precache", () => {
  test("keeps executable shell assets and excludes content media", () => {
    expect(APP_SHELL_GLOB_PATTERNS).toContain("**/*.{js,css,html,ico,png,svg,woff2}");
    expect(APP_SHELL_GLOB_IGNORES).toEqual(["docs/**", "blog/**", "brand/**", "hero/**"]);
  });

  const chunk = (fileName: string, props: Partial<OutputChunk> & { css?: string[]; assets?: string[] } = {}): OutputChunk => {
    const { css = [], assets = [], ...rest } = props;
    return {
      type: "chunk", fileName, imports: [], dynamicImports: [], modules: {}, facadeModuleId: null,
      viteMetadata: { importedCss: new Set(css), importedAssets: new Set(assets) },
      ...rest,
    } as unknown as OutputChunk;
  };
  const bundle: OutputBundle = {
    "assets/main.js": chunk("assets/main.js", { isEntry: true, dynamicImports: ["assets/boot.js"], css: ["assets/main.css"] }),
    "assets/boot.js": chunk("assets/boot.js", {
      imports: ["assets/icon-bell.js"],
      dynamicImports: ["assets/inbox.js", "assets/landing.js", "assets/icon-star.js"],
    }),
    // A lazy route and what it loads lazily in turn: the app, kept.
    "assets/inbox.js": chunk("assets/inbox.js", { facadeModuleId: "/web/app/inbox/page.tsx", dynamicImports: ["assets/diff.js"], assets: ["assets/inbox.woff2"] }),
    "assets/diff.js": chunk("assets/diff.js", { facadeModuleId: "/web/components/diff/PierreDiff.tsx", dynamicImports: ["assets/rust.js"] }),
    // One grammar among hundreds: runtime cache.
    "assets/rust.js": chunk("assets/rust.js", { facadeModuleId: "/n/node_modules/@shikijs/langs/dist/rust.mjs" }),
    // The public site: runtime cache.
    "assets/landing.js": chunk("assets/landing.js", { facadeModuleId: "/web/app/(marketing)/page.tsx" }),
    // An icon boot imports statically stays; one only the icon map names goes.
    "assets/icon-bell.js": chunk("assets/icon-bell.js", { facadeModuleId: "/n/node_modules/lucide-react/dist/esm/icons/bell.js" }),
    "assets/icon-star.js": chunk("assets/icon-star.js", { facadeModuleId: "/n/node_modules/lucide-react/dist/esm/icons/star.js" }),
  };

  test("precaches everything the app reaches, not the grammar, icon and marketing chunks", () => {
    expect([...appShellFiles(bundle)].sort()).toEqual([
      "assets/boot.js",
      "assets/diff.js",
      "assets/icon-bell.js",
      "assets/inbox.js",
      "assets/inbox.woff2",
      "assets/main.css",
      "assets/main.js",
    ]);
  });

  test("the workbox transform keeps files outside assets/ and drops unreached ones", async () => {
    const scope = precacheScope();
    (scope.plugin.configResolved as any)({ build: { assetsDir: "assets" } });
    (scope.plugin.generateBundle as any)({}, bundle);
    const entries = ["index.html", "favicon.ico", "assets/main.js", "assets/rust.js", "assets/landing.js", "assets/icon-star.js"]
      .map((url) => ({ url, revision: null, size: 1 }));
    const { manifest } = await scope.manifestTransform(entries);
    expect(manifest.map((e) => e.url)).toEqual(["index.html", "favicon.ico", "assets/main.js"]);
  });

  describe("navigations (ct-92522)", () => {
    const matches = NAVIGATION_ROUTE.urlPattern as (o: { request: { mode: string }; url: URL }) => boolean;
    const nav = (path: string, mode = "navigate") => matches({ request: { mode }, url: new URL(path, "https://codecast.sh") });

    test("go to the network first, never answered from a stored page", () => {
      expect(NAVIGATION_ROUTE.handler).toBe("NetworkFirst");
      expect(NAVIGATION_ROUTE.options?.cacheableResponse).toEqual({ statuses: [] });
      expect(NAVIGATION_ROUTE.options?.precacheFallback).toEqual({ fallbackURL: "/index.html" });
      expect(NAVIGATION_ROUTE.options?.networkTimeoutSeconds).toBeGreaterThan(0);
    });

    test("cover app pages and leave server endpoints and subresources alone", () => {
      for (const p of ["/", "/pricing", "/inbox", "/conversation/abc", "/blog/post"]) expect(nav(p)).toBe(true);
      for (const p of ["/api/x", "/download/mac", "/install.sh", "/a/1", "/share/2", "/i/3"]) expect(nav(p)).toBe(false);
      expect(nav("/assets/index-abc.js", "cors")).toBe(false);
    });

    test("the matcher serialized into sw.js repeats the denylist exactly", () => {
      expect(String(NAVIGATION_ROUTE.urlPattern)).toContain(`/${SHELL_DENYLIST.source}/`);
    });

    test("the worker no longer answers every navigation from its precache", () => {
      const config = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
      expect(config.match(/navigateFallback\w*\s*:[^,\n]*/g)).toEqual(["navigateFallback: null"]);
      expect(config).toMatch(/runtimeCaching:\s*\[\s*NAVIGATION_ROUTE,/);
    });
  });
});
