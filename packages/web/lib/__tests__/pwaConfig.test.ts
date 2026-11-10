import { describe, expect, test } from "bun:test";
import type { OutputBundle, OutputChunk } from "rollup";
import { APP_SHELL_GLOB_IGNORES, APP_SHELL_GLOB_PATTERNS } from "../../vite.pwa";
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
});
