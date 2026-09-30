import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

// Every Convex entry module must load on its own. The graph has cycles (a
// module that defines functions imports helpers that import it back), which
// ESM tolerates only while no module reads a binding during the partial load.
// A static import placed on the wrong edge throws "Cannot access 'mutation'
// before initialization" at load, and a dynamic import() instead is refused by
// the Convex runtime at call time.
//
// Whether a cycle throws depends on which module of it loads first, and
// Convex bundles each module as its own entry. So each entry loads in its own
// process: importing them all into one process lets an earlier entry warm the
// module cache, and a later entry that would throw on its own passes (the
// repos.ts -> ... -> gitActivity.ts -> repos.ts cycle hid that way).
const DIR = join(import.meta.dir);
const PKG = join(DIR, "..");
const entries = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && f !== "schema.ts");

type Load = { code: number | null; stderr: string };

async function loadAlone(file: string): Promise<Load> {
  const proc = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(join(DIR, file))})`], {
    cwd: PKG,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 120_000,
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

// A small pool: one child per entry, a few at a time.
function pooled(files: string[], width: number): Map<string, Promise<Load>> {
  const queue = [...files];
  const results = new Map<string, Promise<Load>>();
  const resolvers = new Map<string, (load: Load) => void>();
  for (const f of files) results.set(f, new Promise((resolve) => resolvers.set(f, resolve)));
  const worker = async () => {
    for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
      resolvers.get(f)!(await loadAlone(f).catch((e) => ({ code: -1, stderr: String(e) })));
    }
  };
  for (let i = 0; i < width; i++) void worker();
  return results;
}

let loads: Map<string, Promise<Load>>;
beforeAll(() => {
  loads = pooled(entries, Math.max(2, Math.min(8, availableParallelism())));
});

describe("every entry module loads on its own", () => {
  for (const file of entries) {
    test(
      file,
      async () => {
        const { code, stderr } = await loads.get(file)!;
        expect({ file, code, stderr: code === 0 ? "" : stderr.trim().split("\n").slice(-12).join("\n") }).toEqual({
          file,
          code: 0,
          stderr: "",
        });
      },
      300_000,
    );
  }
});
