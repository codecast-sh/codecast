import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Every Convex entry module must load on its own. The graph has cycles (a
// module that defines functions imports helpers that import it back), which
// ESM tolerates only while no module reads a binding during the partial load.
// A static import placed on the wrong edge throws "Cannot access 'mutation'
// before initialization" at load, and a dynamic import() instead is refused by
// the Convex runtime at call time. Loading each entry here is the check.
const DIR = join(import.meta.dir);
const entries = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && f !== "schema.ts");

describe("every entry module loads", () => {
  for (const file of entries) {
    test(file, async () => {
      await expect(import(join(DIR, file))).resolves.toBeDefined();
    });
  }
});
