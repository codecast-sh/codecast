// A substitution of the store must not answer for the rest of the suite.
//
// `mock.module` is process-global and permanent, and bun runs every test file
// in one process. So a file that replaces `store/inboxStore` with a stub keeps
// answering for every file that loads the store AFTER it. The stub is narrow by
// design — a fake state, a `useTrackedStore` — so the next file reads a store
// with no actions and dies on `setState`, `getState().recordSyncMeta`,
// `store._setOutbox`. One mount test took out 958 unrelated tests this way, and
// each file passed on its own, which is what makes it so hard to see.
//
// Two ways to be safe, and this guard accepts either:
//
//   - `mockInboxStore(...)` from ./mockInboxStore — it keeps the real module,
//     keeps the hook's own methods, and restores in its own afterAll;
//   - a hand-rolled substitution that SPREADS `realInboxStore` (so the module
//     keeps its other exports while the file runs) AND calls
//     `restoreInboxStoreAfterAll()` (so the real module is back when it ends).
//
// The same reasoning applies to any module a sibling file imports: spread the
// real one rather than dropping its exports. The store earns its own guard
// because it is the module every surface reads.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..");
const SKIP = new Set(["node_modules", ".next", "dist", "build", ".vite"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) testFiles(join(dir, e.name), out);
      continue;
    }
    if (/\.test\.tsx?$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** A substitution of the store module, by any relative path that ends in it. */
const SUBSTITUTES_STORE = /mock\.module\(\s*["'][^"']*\/inboxStore["']/;

describe("a store substitution cannot leak into the next test file", () => {
  test("every file that substitutes inboxStore keeps its exports and restores it", () => {
    const offenders: string[] = [];
    for (const file of testFiles(WEB)) {
      const src = readFileSync(file, "utf8");
      if (!SUBSTITUTES_STORE.test(src)) continue;
      const rel = file.slice(WEB.length + 1);
      if (rel.endsWith("mockInboxStore.ts")) continue;
      // The helper restores itself, so a file that uses it needs nothing else.
      if (src.includes("mockInboxStore(")) continue;
      const spreads = src.includes("...realInboxStore") || src.includes("...realStore");
      // Either the shared helper, or the file's own put-back: re-registering
      // the real namespace it captured, whatever it named the snapshot.
      const restores = src.includes("restoreInboxStoreAfterAll(")
        || /mock\.module\(\s*["'][^"']*\/inboxStore["']\s*,\s*\(\)\s*=>\s*real\w*\s*\)/.test(src);
      if (!spreads) offenders.push(`${rel}: substitutes the store without spreading its real exports`);
      if (!restores) offenders.push(`${rel}: substitutes the store and never puts it back (restoreInboxStoreAfterAll)`);
    }
    expect(offenders).toEqual([]);
  });
});
