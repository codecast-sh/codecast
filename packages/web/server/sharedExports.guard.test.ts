// The web server (server/*.ts) runs under plain bun, not through the bundler,
// so every "@codecast/shared/<subpath>" it imports must be an export in
// packages/shared/package.json. A missing one passes typecheck and the bundled
// app, and kills `bun run server/index.ts` at boot with "Cannot find module"
// (55d520653 imported contracts/agentAccess before it was exported).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER = import.meta.dir;
const SHARED_PKG = join(SERVER, "../../shared/package.json");

function missingSharedExports(sources: string[], exportKeys: string[]): string[] {
  const exact = new Set(exportKeys);
  const patterns = exportKeys.filter((k) => k.includes("*")).map((k) => new RegExp(`^${k.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("\\*", ".*").replace("*", ".*")}$`));
  const missing = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/from\s+["']@codecast\/shared(\/[^"']+)?["']/g)) {
      const key = m[1] ? `.${m[1]}` : ".";
      if (!exact.has(key) && !patterns.some((re) => re.test(key))) missing.add(key);
    }
  }
  return [...missing].sort();
}

test("the checker catches an unexported subpath", () => {
  const src = 'import { MCP_ROUTES } from "@codecast/shared/contracts/agentAccess";';
  expect(missingSharedExports([src], [".", "./contracts"])).toEqual(["./contracts/agentAccess"]);
  expect(missingSharedExports([src], [".", "./contracts/*"])).toEqual([]);
});

test("every shared subpath the web server imports is exported", () => {
  const exportKeys = Object.keys(JSON.parse(readFileSync(SHARED_PKG, "utf8")).exports ?? {});
  const sources = readdirSync(SERVER)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(SERVER, f), "utf8"));
  expect(missingSharedExports(sources, exportKeys)).toEqual([]);
});
