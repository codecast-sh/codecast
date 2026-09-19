import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildBootGraph, importChain, type GraphOptions } from "../../cli/src/bench/bootGraph";

// The native bundle's import graph, walked the way Metro walks it, in seconds
// and without Metro. It exists because a production OTA export failed after a
// 45 minute bundle (ct-50923): app/plan/[id].tsx imported the shared inbox
// store, the store imported the desktop stage, and the stage pulled in
// RoutePane, whose `@/app/tasks/page` import means "packages/web" to Next and
// "packages/mobile" to Metro. Metro applies the MOBILE tsconfig paths to every
// file it reads, so an `@/` import inside a shared web file either fails the
// build or silently binds to a mobile file of the same name.

const mobileRoot = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(mobileRoot, "../..");

const ALIASES: [string, string][] = [
  ["@/", mobileRoot + "/"],
  ["@codecast/web/", path.join(repoRoot, "packages/web") + "/"],
  ["@codecast/convex/", path.join(repoRoot, "packages/convex") + "/"],
];

function metroOptions(platform: "ios" | "android"): GraphOptions {
  return {
    calls: true,
    platforms: [platform, "native"],
    alias: (spec) => {
      for (const [prefix, dir] of ALIASES) if (spec.startsWith(prefix)) return dir + spec.slice(prefix.length);
      return null;
    },
  };
}

// expo-router requires every file under app/, so each one is an entry.
function entries(): string[] {
  const out = [path.join(mobileRoot, "index.ts")];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
  })(path.join(mobileRoot, "app"));
  return out;
}

const rel = (f: string) => path.relative(repoRoot, f);

for (const platform of ["ios", "android"] as const) {
  describe(`${platform} bundle graph`, () => {
    const graph = buildBootGraph(entries(), repoRoot, metroOptions(platform));
    const chainTo = (file: string) => (importChain(graph, file) ?? []).slice(1).map(rel).join(" -> ");

    test("every aliased import resolves to a file Metro can read", () => {
      // A specifier with only a .d.ts behind it is types; Babel erases the import.
      const typesOnly = (spec: string) => fs.existsSync(metroOptions(platform).alias!(spec, "", repoRoot) + ".d.ts");
      const broken = [...graph.externals].filter(
        (spec) => ALIASES.some(([prefix]) => spec.startsWith(prefix)) && !typesOnly(spec),
      );
      expect(broken).toEqual([]);
    });

    test("no web route or desktop stage file reaches the native bundle", () => {
      const webOnly = [...graph.nodes.keys()].filter((f) =>
        /packages\/web\/(app\/|components\/RoutePane|components\/stage\/)/.test(f),
      );
      expect(webOnly.map(chainTo)).toEqual([]);
    });

    // One `import { captureException } from "@sentry/react"` in a shared hook
    // shipped ~300 files of a second Sentry version to the phone. Shared code
    // reports through ../lib/analytics, which has a native twin.
    test("no web only SDK reaches the native bundle", () => {
      const WEB_ONLY = ["@sentry/react", "@sentry/browser", "posthog-js", "dexie"];
      const hit = [...graph.externals].filter((spec) => WEB_ONLY.some((pkg) => spec === pkg || spec.startsWith(pkg + "/")));
      expect(hit).toEqual([]);
    });

    test("a shared web file never uses the @/ alias, which Metro points at mobile", () => {
      const offenders: string[] = [];
      for (const file of graph.nodes.keys()) {
        if (!file.includes("/packages/web/")) continue;
        if (/from\s*["']@\/|(?:import|require)\(\s*["']@\//.test(fs.readFileSync(file, "utf8"))) offenders.push(rel(file));
      }
      expect(offenders).toEqual([]);
    });
  });
}
