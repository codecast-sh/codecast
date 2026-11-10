import type { Plugin, ResolvedConfig } from "vite";
import type { OutputBundle, OutputChunk } from "rollup";
import { inlineIife } from "./inlineIife";
import { EARLY_ROUTES } from "../src/earlyRoutePaths";

/**
 * Inlines the browser → desktop hand-off gate into index.html's <head>.
 *
 * A page that is only going to be handed to the desktop app should never pay
 * for an app boot, so the gate has to run before any module is fetched — which
 * means inline, in the document head. lib/desktopHandoff.ts is import-free
 * exactly so esbuild can turn it into a standalone IIFE here; nothing is
 * duplicated between it and the React fallback path.
 *
 * The plugin also hands the script the module URLs for the app entry's dynamic
 * import (src/boot.tsx and its static dependency graph). Splitting the entry is
 * what makes skipping the app possible, but it also moved those chunks out of
 * Vite's own <link rel="modulepreload"> hints; the script re-injects them
 * synchronously on a normal load, so nothing about that path got slower, and
 * skips them on a handoff, so nothing is fetched at all.
 *
 * Two more lists ride along. A route main.tsx starts early (src/earlyRoutePaths)
 * has its own graph, preloaded only when the page opens on that route: counted
 * as part of the app, /flows's 127 chunks were preloaded on every page. And the
 * stylesheets of what is preloaded are preloaded too, so Vite's loader, which
 * waits for them before it runs boot, finds them already fetched instead of
 * starting them after the entry has run.
 */

const PLUGIN_NAME = "codecast-handoff-boot";
const GATE_SOURCE = "lib/desktopHandoff.ts";
const GLOBAL_NAME = "__ccHandoffBoot";

export function handoffBootPlugin(): Plugin {
  let config: ResolvedConfig;

  return {
    name: PLUGIN_NAME,
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml: {
      // `post` so the build bundle is available and the entry's own tags are
      // already in place.
      order: "post",
      async handler(_html, ctx) {
        const preload = ctx.bundle ? bootChunkUrls(ctx.bundle, ctx.chunk, config.base) : EMPTY;
        const code = await inlineIife(config.root, GATE_SOURCE, GLOBAL_NAME);
        return [
          {
            tag: "script",
            children: `${code};${preBootCall(preload)}`,
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}

const SHARE_BOOT_MODULE = "/src/shareBoot.tsx";
const BOOT_MODULE = "/src/boot.tsx";

/** A graph preloaded when the page opens on a path the pattern matches. */
export type RoutePreload = { path: string; flags: string; urls: string[]; css: string[] };
export type BootPreload = {
  app: string[];
  appCss: string[];
  share: string[];
  conversation: string[];
  routes: RoutePreload[];
};

const EMPTY: BootPreload = { app: [], appCss: [], share: [], conversation: [], routes: [] };

/**
 * The inline call: picks the early route's graph by path, hands the module
 * URLs to runPreBootHandoff (which preloads them unless the page hands off or
 * is held), then preloads the stylesheets on a page that boots now. A held or
 * handed-off page leaves its stylesheets to Vite's loader. The two window
 * flags are the ones lib/desktopHandoff.ts sets (pinned by handoffBoot.test.ts).
 *
 * Every URL is written once, in a table the lists index into: the early
 * routes' graphs overlap almost entirely, and this script is parsed on every
 * page before anything else.
 */
export function preBootCall(p: BootPreload): string {
  const table: string[] = [];
  const index = new Map<string, number>();
  const ix = (list: string[]) => list.map((url) => {
    let i = index.get(url);
    if (i === undefined) {
      i = table.length;
      table.push(url);
      index.set(url, i);
    }
    return i;
  });
  const lists = [ix(p.app), ix(p.appCss), ix(p.share), ix(p.conversation)];
  const routes = p.routes.map((r) => [r.path, r.flags, ix(r.urls), ix(r.css)]);
  return `(function(h,t,a,c,s,v,r){function u(x){for(var o=[],i=0;i<x.length;i++)o.push(t[x[i]]);return o}var p=location.pathname;`
    + `for(var i=0;i<r.length;i++)if(new RegExp(r[i][0],r[i][1]).test(p)){a=a.concat(r[i][2]);c=c.concat(r[i][3])}`
    + `h.runPreBootHandoff(u(a),u(s),u(v));`
    + `if(h.isStandaloneSharePath(p)||window.__ccHandoffPending||window.__ccHandoffHold)return;`
    + `c=u(c);for(var j=0;j<c.length;j++){var l=document.createElement("link");l.rel="preload";l.as="style";l.crossOrigin="";l.href=c[j];document.head.appendChild(l)}`
    + `})(${GLOBAL_NAME},${JSON.stringify(table)},${lists.map((l) => JSON.stringify(l)).join(",")},${JSON.stringify(routes)})`;
}

/**
 * What the html entry chunk defers behind its dynamic imports, plus everything
 * those chunks statically pull in, as URLs — split into the app graph
 * (src/boot.tsx), the standalone share-page graph (src/shareBoot.tsx) and one
 * graph per early route, so each kind of page preloads only what it will run.
 *
 * Keyed off the chunks' modules rather than `facadeModuleId`: Rollup is free
 * to merge a dynamic entry into a shared chunk (boot is one), which leaves
 * `facadeModuleId` null.
 */
export function bootChunkUrls(
  bundle: OutputBundle,
  entryChunk: OutputChunk | undefined,
  base: string,
): BootPreload {
  const entry = entryChunk ?? (Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry) as OutputChunk | undefined);
  if (!entry?.dynamicImports.length) {
    // Not fatal, but every normal page load would then wait a whole round trip
    // for the entry to run before it could even start fetching the app.
    console.warn(`[${PLUGIN_NAME}] no dynamic import found on the html entry chunk — the app preload hints are missing.`);
    return EMPTY;
  }

  const prefix = base.endsWith("/") ? base : `${base}/`;
  const graph = (roots: string[], includeImports = true): string[] => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const chunk = bundle[file];
      if (chunk?.type !== "chunk") return;
      // Static imports only — matching what Vite would have preloaded. The boot
      // chunk's own dynamic imports (lazy routes, mermaid, …) stay on demand.
      if (includeImports) for (const next of chunk.imports) walk(next);
    };
    roots.forEach(walk);
    return [...seen];
  };
  const urls = (files: string[]) => files.map((file) => `${prefix}${file}`);
  const css = (files: string[]) => {
    const out = new Set<string>();
    for (const file of files) {
      const chunk = bundle[file];
      if (chunk?.type === "chunk") for (const sheet of chunk.viteMetadata?.importedCss ?? []) out.add(sheet);
    }
    return [...out];
  };
  const holds = (file: string, module: string) => {
    const chunk = bundle[file];
    return chunk?.type === "chunk" && Object.keys(chunk.modules).some((id) => id.endsWith(module));
  };

  const share = entry.dynamicImports.filter((f) => holds(f, SHARE_BOOT_MODULE));
  const boot = entry.dynamicImports.filter((f) => holds(f, BOOT_MODULE));
  if (!boot.length) console.warn(`[${PLUGIN_NAME}] no chunk holds ${BOOT_MODULE} — the app preload hints are missing.`);
  const app = graph(boot);
  const appCss = css(app);

  const inApp = new Set(app);
  const inAppCss = new Set(appCss);
  const routes: RoutePreload[] = [];
  for (const route of EARLY_ROUTES) {
    const opener = entry.dynamicImports.filter((f) => holds(f, `/${route.module}`));
    if (!opener.length) {
      console.warn(`[${PLUGIN_NAME}] no chunk holds the early route ${route.module} — it is not preloaded.`);
      continue;
    }
    const files = graph(opener).filter((f) => !inApp.has(f));
    routes.push({
      path: route.path.source,
      flags: route.path.flags,
      urls: urls(files),
      css: css(files).filter((sheet) => !inAppCss.has(sheet)).map((sheet) => `${prefix}${sheet}`),
    });
  }

  const conversation = Object.values(bundle)
    .filter((chunk): chunk is OutputChunk => chunk.type === "chunk"
      && Object.keys(chunk.modules).some((id) => id.endsWith("/components/ConversationDiffLayout.tsx")))
    .map((chunk) => chunk.fileName);
  return {
    app: urls(app),
    appCss: appCss.map((sheet) => `${prefix}${sheet}`),
    share: urls(graph(share)),
    conversation: urls(graph(conversation, false)),
    routes,
  };
}
