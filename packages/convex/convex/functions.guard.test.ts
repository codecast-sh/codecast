import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Coverage guard: the change feed is only complete if every file that WRITES a
// tracked table routes its mutations through ./functions (the write interceptor),
// not the raw ./_generated/server builders. This turns the "did someone forget to
// emit?" discipline problem into a CI failure.
//
// Reliable signal: a file that `.insert("<tracked>")` must NOT import
// mutation/internalMutation from ./_generated/server. (Patch/delete-only writers
// can't be detected statically by table name, but they live in the same core
// files this catches, and they go through the same wrapped ctx.db regardless.)
const DIR = import.meta.dir;
const TRACKED = ["conversations", "tasks", "docs", "plans"];

function importsRawBuilder(src: string): boolean {
  const blocks = [...src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']\.\/_generated\/server["']/g)];
  return blocks.some((m) => /\b(mutation|internalMutation)\b/.test(m[1]));
}

function insertsTrackedTable(src: string): boolean {
  return TRACKED.some((t) => src.includes(`.insert("${t}"`));
}

describe("change-feed write interceptor coverage", () => {
  test("no file that inserts a tracked table imports raw mutation builders", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "functions.ts") continue;
      const src = readFileSync(join(DIR, f), "utf8");
      if (insertsTrackedTable(src) && importsRawBuilder(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("the interceptor itself stays wired to the raw generated builders", () => {
    const src = readFileSync(join(DIR, "functions.ts"), "utf8");
    expect(importsRawBuilder(src)).toBe(true);
  });
});
