import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OutputBundle, OutputChunk } from "rollup";
import { bootChunkUrls, preBootCall } from "./handoffBoot";

const chunk = (fileName: string, props: Partial<OutputChunk> & { css?: string[] } = {}): OutputChunk => {
  const { css = [], ...rest } = props;
  return {
    type: "chunk", fileName, imports: [], dynamicImports: [], modules: {},
    viteMetadata: { importedCss: new Set(css), importedAssets: new Set() },
    ...rest,
  } as unknown as OutputChunk;
};
const mod = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, {} as any]));

describe("boot preloads", () => {
  test("preloads the merged conversation chunk without pulling in its whole graph", () => {
    const entry = chunk("main.js", { isEntry: true, dynamicImports: ["boot.js", "share.js"] });
    const bundle: OutputBundle = {
      "main.js": entry,
      "boot.js": chunk("boot.js", { modules: mod("/web/src/boot.tsx"), imports: ["vendor.js"], dynamicImports: ["conversation.js"] }),
      "share.js": chunk("share.js", { facadeModuleId: "/web/src/shareBoot.tsx", modules: mod("/web/src/shareBoot.tsx") }),
      "conversation.js": chunk("conversation.js", {
        facadeModuleId: null,
        modules: mod("/web/components/ConversationDiffLayout.tsx"),
        imports: ["vendor.js", "messages.js"],
        dynamicImports: ["diagram.js"],
      }),
      "vendor.js": chunk("vendor.js"),
      "messages.js": chunk("messages.js", { imports: ["vendor.js"] }),
      "diagram.js": chunk("diagram.js"),
    };
    const preload = bootChunkUrls(bundle, entry, "/app/");
    expect(preload.app).toEqual(["/app/boot.js", "/app/vendor.js"]);
    expect(preload.share).toEqual(["/app/share.js"]);
    expect(preload.conversation).toEqual(["/app/conversation.js"]);
  });

  test("an early route's graph is preloaded on its own path, never as part of the app", () => {
    // main.tsx's startRouteModule makes each early route a dynamic import of
    // the html entry beside boot; counted as the app, /flows's whole graph
    // was preloaded on every page.
    const entry = chunk("main.js", { isEntry: true, dynamicImports: ["boot-merged.js", "flows.js"] });
    const bundle: OutputBundle = {
      "main.js": entry,
      // Boot merged into a shared chunk: no facade, found by its module.
      "boot-merged.js": chunk("boot-merged.js", {
        facadeModuleId: null,
        modules: mod("/web/src/boot.tsx", "/web/src/App.tsx"),
        imports: ["vendor.js"],
        css: ["assets/boot.css"],
      }),
      "flows.js": chunk("flows.js", {
        facadeModuleId: "/web/app/flows/page.tsx",
        modules: mod("/web/app/flows/page.tsx"),
        imports: ["vendor.js", "editor.js"],
        css: ["assets/flows.css"],
      }),
      "vendor.js": chunk("vendor.js", { css: ["assets/vendor.css"] }),
      "editor.js": chunk("editor.js"),
    };
    const preload = bootChunkUrls(bundle, entry, "/");
    expect(preload.app).toEqual(["/boot-merged.js", "/vendor.js"]);
    expect(preload.appCss).toEqual(["/assets/boot.css", "/assets/vendor.css"]);
    const flows = preload.routes.find((r) => new RegExp(r.path, r.flags).test("/flows"));
    expect(flows?.urls).toEqual(["/flows.js", "/editor.js"]);
    expect(flows?.css).toEqual(["/assets/flows.css"]);
    expect(new RegExp(flows!.path, flows!.flags).test("/inbox")).toBe(false);
  });

  test("the inline call is valid script that preloads the route only on its path", () => {
    const call = preBootCall({
      app: ["/boot.js", "/vendor.js"],
      appCss: ["/boot.css"],
      share: ["/share.js", "/vendor.js"],
      conversation: ["/conversation.js"],
      routes: [{ path: "^\\/flows\\/?$", flags: "", urls: ["/flows.js", "/editor.js"], css: ["/flows.css"] }],
    });
    // Each URL is written once.
    expect(call.match(/\/vendor\.js/g)).toHaveLength(1);
    const run = (pathname: string, flags: Record<string, unknown> = {}) => {
      const handed: string[][][] = [];
      const links: { rel: string; href: string }[] = [];
      const fakeDocument = { createElement: () => ({}) as any, head: { appendChild: (l: any) => links.push(l) } };
      const hook = {
        runPreBootHandoff: (...lists: string[][]) => handed.push(lists),
        isStandaloneSharePath: (p: string) => p.startsWith("/share/"),
      };
      new Function("__ccHandoffBoot", "location", "window", "document", call)(hook, { pathname }, flags, fakeDocument);
      return { modules: handed[0], styles: links.map((l) => `${l.rel}:${l.href}`) };
    };
    const lists = (app: string[]) => [app, ["/share.js", "/vendor.js"], ["/conversation.js"]];
    expect(run("/inbox")).toEqual({ modules: lists(["/boot.js", "/vendor.js"]), styles: ["preload:/boot.css"] });
    expect(run("/flows")).toEqual({
      modules: lists(["/boot.js", "/vendor.js", "/flows.js", "/editor.js"]),
      styles: ["preload:/boot.css", "preload:/flows.css"],
    });
    // A share page, a handoff and a held tab leave stylesheets to Vite's loader.
    expect(run("/share/doc/x").styles).toEqual([]);
    expect(run("/inbox", { __ccHandoffPending: true }).styles).toEqual([]);
    expect(run("/inbox", { __ccHandoffHold: Promise.resolve(false) }).styles).toEqual([]);
  });

  test("the window flags the inline call reads are the ones the gate sets", () => {
    const gate = readFileSync(join(import.meta.dir, "../lib/desktopHandoff.ts"), "utf8");
    expect(gate).toContain('const HANDOFF_PENDING_FLAG = "__ccHandoffPending";');
    expect(gate).toContain('const HANDOFF_HOLD_FLAG = "__ccHandoffHold";');
    expect(gate).toMatch(/export function isStandaloneSharePath\(/);
  });
});
