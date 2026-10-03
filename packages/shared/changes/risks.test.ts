import { describe, expect, test } from "bun:test";
import { commit } from "./__fixtures__/commit";
import { isGeneratedPath } from "./classify";
import { BULK_LINES, computeRisks } from "./risks";

const base = { conversations: [], pr_ids: [], task_ids: [] };
const ctx = { ships: [], linked: true };

/** A commit's story, its size read off the commit the way buildDay sums it. */
const storyOf = (c: ReturnType<typeof commit>) => ({ ...base, units: [{ commit: c, area: null }], insertions: c.insertions, deletions: c.deletions });

describe("bulk", () => {
  test("a brand commit that is mostly fonts and snapshots is not bulk", () => {
    const paths: Record<string, number> = {};
    for (let i = 0; i < 40; i++) paths[`packages/web/public/fonts/face-${i}.woff2`] = 400;
    for (let i = 0; i < 30; i++) paths[`packages/web/public/brand/mark-${i}.png`] = 120;
    for (let i = 0; i < 10; i++) paths[`packages/db/drizzle/meta/00${i}_snapshot.json`] = 900;
    paths["bun.lock"] = 600;
    for (let i = 0; i < 14; i++) paths[`packages/web/components/brand/Part${i}.tsx`] = 60;
    expect(Object.keys(paths)).toHaveLength(95);
    const c = commit({ sha: "brand", paths });
    expect(c.insertions).toBeGreaterThan(BULK_LINES * 10);
    expect(computeRisks(storyOf(c), ctx)).toEqual([]);
  });

  test("the same source lines without the generated files around them still count", () => {
    const paths: Record<string, number> = {};
    for (let i = 0; i < 20; i++) paths[`packages/web/components/x/Part${i}.tsx`] = 80;
    paths["bun.lock"] = 5000;
    const risks = computeRisks(storyOf(commit({ sha: "big", paths })), ctx);
    expect(risks.map((r) => r.code)).toEqual(["bulk"]);
    expect(risks[0].evidence[0]).toBe("1600 lines");
  });

  test("a slice counts only its own area's generated lines", () => {
    const c = commit({ sha: "s", paths: { "packages/web/a.tsx": 1600, "packages/cli/bun.lock": 3000, "docs/x.png": 10 } });
    const slice = { ...base, units: [{ commit: c, area: "web" }], insertions: 1600, deletions: 0 };
    expect(computeRisks(slice, ctx).map((r) => r.code)).toEqual(["bulk"]);
  });
});

describe("isGeneratedPath", () => {
  test("lockfiles, snapshots, generated code, fixtures, fonts and images", () => {
    for (const p of [
      "bun.lock", "packages/web/package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum",
      "drizzle/meta/0007_snapshot.json", "packages/convex/convex/_generated/api.d.ts",
      "packages/cli/src/__fixtures__/x/calls.md", "src/__snapshots__/a.test.ts.snap", "x.snap",
      "public/fonts/Inter.woff2", "a/b.ttf", "public/og.PNG", "icon.svg",
    ]) expect([p, isGeneratedPath(p)]).toEqual([p, true]);
    for (const p of ["packages/web/app/globals.css", "drizzle/0007_add.sql", "src/lock.ts", "docs/fixtures.md", "meta/notes.json"]) {
      expect([p, isGeneratedPath(p)]).toEqual([p, false]);
    }
  });
});
