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
