// Private eval data (runs, freezes, moments, replies) must never reach Convex,
// IndexedDB or a published page (docs/architecture/evals-ui.md 3.6). The Evals
// area keeps it in store/evalsStore.ts, in memory. This guard fails when the
// persisted store layer learns about it: an evals type or module imported into
// inboxStore, the client sync registry or the IndexedDB cache would be the
// first step toward caching it on disk. It also holds evalsStore itself to
// memory: no persist middleware, no IndexedDB, no localStorage writes.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const storeDir = join(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(storeDir, file), "utf8");

/** The persisted layer: what it imports is what can end up on disk. */
const GUARDED = ["inboxStore.ts", "clientSyncRegistry.ts", "idbCache.ts"];

/** Module specifiers that carry eval data or its types. */
const EVALS_MODULE = /(?:contracts\/evalsApi|\/evals\/|evalsStore|lib\/evals\b|components\/evals\b)/;

/** Every import or export-from whose specifier is an evals module, as `line: text`. */
export function evalsImports(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? "";
    if (EVALS_MODULE.test(spec)) {
      const line = source.slice(0, m.index).split("\n").length + (m[0].startsWith("\n") ? 1 : 0);
      out.push(`${line}: ${spec}`);
    }
  }
  return out;
}

describe("evals data stays out of the persisted store layer", () => {
  for (const file of GUARDED) {
    it(`${file} imports nothing from the evals`, () => {
      expect(evalsImports(read(file))).toEqual([]);
    });
  }

  it("catches an evals type imported into inboxStore", () => {
    const planted = `import type { RunRow } from "@codecast/shared/contracts/evalsApi";\n${read("inboxStore.ts")}`;
    expect(evalsImports(planted)).toEqual(["1: @codecast/shared/contracts/evalsApi"]);
  });

  it("catches the evals store, client and components however they are reached", () => {
    expect(evalsImports(`import { useEvalsStore } from "./evalsStore";`)).toEqual(["1: ./evalsStore"]);
    expect(evalsImports(`const x = 1;\nexport { callEvals } from "../lib/evals/client";`)).toEqual(["2: ../lib/evals/client"]);
    expect(evalsImports(`await import("../components/evals/__fixtures__/world")`)).toHaveLength(1);
    expect(evalsImports(`import type { Thing } from "./evalsLike";`)).toEqual([]);
  });

  it("evalsStore keeps its data in memory only", () => {
    const src = read("evalsStore.ts");
    expect(src).not.toMatch(/\bpersist\s*\(/);
    expect(src).not.toMatch(/from\s+["'][^"']*(idbCache|dexie|zustand\/middleware)["']/);
    expect(src).not.toMatch(/localStorage\.setItem|sessionStorage\.setItem|indexedDB/);
  });
});
