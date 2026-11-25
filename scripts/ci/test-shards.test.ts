import { describe, expect, test } from "bun:test";

import { junitTimes, shard, SUITES, testFiles } from "./test-shards";

describe("test-shards", () => {
  test("every test file of each suite lands in exactly one shard", () => {
    for (const pkg of Object.keys(SUITES)) {
      const files = testFiles(pkg);
      expect(files.length, pkg).toBeGreaterThan(100);
      for (const n of [1, 3, 4, 8]) {
        const all = shard(files, {}, n).flat().sort();
        expect(all, `${pkg} ${n}`).toEqual(files);
      }
    }
  });

  test("fills shards by recorded time, longest first", () => {
    const times = { a: 10, b: 6, c: 5, d: 4, e: 1 };
    const shards = shard(Object.keys(times), times, 2);
    const load = (s: string[]) => s.reduce((n, f) => n + times[f as keyof typeof times], 0);
    expect(shards.map(load).sort()).toEqual([12, 14]);
  });

  test("a file with no recorded time counts as the median", () => {
    const shards = shard(["slow", "new", "x", "y"], { slow: 9, x: 1, y: 1 }, 2);
    expect(shards.find((s) => s.includes("slow"))).toEqual(["slow"]);
  });

  test("reads one time per file from bun's JUnit report", () => {
    const xml = `<testsuites>\n  <testsuite name="a.test.ts" file="a.test.ts" time="1.234">\n    <testsuite name="inner" time="9">\n    </testsuite>\n  </testsuite>\n</testsuites>`;
    expect(junitTimes(xml)).toEqual({ "a.test.ts": 1.2 });
  });
});
