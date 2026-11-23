import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkSources, WEB_ROOT } from "./sourceWalk";

// ct-91263: a lazy loader that maps a named export by hand,
//   lazy(() => import("./x").then((m) => ({ default: m.X })))
// reads `.X` off undefined when Vite resolves a cancelled stale-chunk preload
// with undefined, and production saw "Cannot read properties of undefined
// (reading 'SettingsModal')". Every named-export lazy loader goes through
// lib/lazyNamed.ts, which waits out that reload and names a real missing export.
//
// The raw mapping is one shape among several (`(loaded = module.X)`, an async
// lazy that indexes the module, `.then((m) => m.X)` handed to a wrapper), so
// the guard also reads every React.lazy call: one that does more than
// `lazy(() => import("./x"))` lives in a file that goes through lib/lazyNamed.ts.

// Lazies over loaders that resolve a whole module for its default export,
// which is all React.lazy reads.
const DEFAULT_MODULE_LOADERS = new Set([
  "src/App.tsx", // lazy(loadFlowsPage) and siblings: once(() => import("@/app/flows/page")) in src/earlyRoutes.ts
  "lib/tabLazyPages.ts", // lazyPage(key, loader): loader is typed () => Promise<{ default: ComponentType }>
]);
const LAZY_CALL = /(?<![\w$.])(?:React\.)?lazy\(/g;
const PLAIN_DEFAULT = /^\s*\(\)\s*=>\s*import\(\s*["'`][^"'`]+["'`]\s*\)\s*,?\s*$/;
const USES_HELPER = /from\s+["'][./]*(?:lib\/)?lazyNamed["']/;

// The argument text of the call whose "(" sits at `open`.
function callArgument(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

const DIRS = ["app", "components", "hooks", "lib", "src", "store"];
const RAW_MAPPING = /\(\{\s*default:\s*([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*/g;

test("no lazy loader picks a named export without lazyNamed", () => {
  const offenders: string[] = [];
  for (const dir of DIRS) {
    for (const file of walkSources(join(WEB_ROOT, dir))) {
      const rel = file.slice(WEB_ROOT.length + 1);
      if (rel === "lib/lazyNamed.ts") continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(RAW_MAPPING)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line}: ${m[0]}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("every React.lazy beyond a plain default import goes through lazyNamed", () => {
  const offenders: string[] = [];
  for (const dir of DIRS) {
    for (const file of walkSources(join(WEB_ROOT, dir))) {
      const rel = file.slice(WEB_ROOT.length + 1);
      if (rel === "lib/lazyNamed.ts" || DEFAULT_MODULE_LOADERS.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (USES_HELPER.test(src)) continue;
      for (const m of src.matchAll(LAZY_CALL)) {
        const line = src.slice(0, m.index).split("\n").length;
        const lineText = src.split("\n")[line - 1].trim();
        if (lineText.startsWith("//") || lineText.startsWith("*")) continue;
        const arg = callArgument(src, m.index! + m[0].length - 1);
        if (!PLAIN_DEFAULT.test(arg)) offenders.push(`${rel}:${line}: lazy(${arg.trim().slice(0, 60)}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
