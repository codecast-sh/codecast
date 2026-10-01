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
// module cache, and a later entry that would throw on its own passes.
//
// The entries are every module Convex registers, subdirectories included
// (lib/, emails/, fileChanges/): the set _generated/api.d.ts lists.
const DIR = join(import.meta.dir);
const PKG = join(DIR, "..");
const entries = (readdirSync(DIR, { recursive: true }) as string[])
  .filter((f) => f.endsWith(".ts") && !f.startsWith("_generated") && !/\.(test|d)\.ts$/.test(f) && f !== "schema.ts")
  .sort();

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

// One child per entry, at most `width` at a time, started in list order.
function limit(width: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= width) await new Promise<void>((go) => waiting.push(go));
    active++;
    try {
      return await run();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

let loads: Map<string, Promise<Load>>;
beforeAll(() => {
  const slot = limit(Math.max(2, Math.min(8, availableParallelism())));
  loads = new Map(entries.map((f) => [f, slot(() => loadAlone(f).catch((e) => ({ code: -1, stderr: String(e) })))]));
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
