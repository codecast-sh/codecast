import { describe, expect, test } from "bun:test";
import { ProcessCwdCache } from "./processCwdCache.js";

/** `lsof -a -d cwd -p <pids> -F pn` as lsof prints it, for the pids that are alive. */
function lsofOut(cwds: Record<number, string>, pids: number[]): string {
  return pids.filter((p) => p in cwds).map((p) => `p${p}\nfcwd\nn${cwds[p]}\n`).join("");
}

function harness(cwds: Record<number, string>) {
  let now = 1_000;
  const calls: number[][] = [];
  const cache = new ProcessCwdCache(async (pids) => { calls.push(pids); return lsofOut(cwds, pids); }, () => now, 30_000);
  return { cache, calls, advance: (ms: number) => { now += ms; } };
}

describe("ProcessCwdCache", () => {
  test("one lsof answers every pid, and a dead pid reads as null", async () => {
    const { cache, calls } = harness({ 10: "/a", 11: "/b" });
    const got = await cache.cwds([10, 11, 12]);
    expect(calls).toEqual([[10, 11, 12]]);
    expect([...got]).toEqual([[10, "/a"], [11, "/b"], [12, null]]);
  });

  test("answers stay for the TTL, then the next read asks again", async () => {
    const { cache, calls, advance } = harness({ 10: "/a" });
    await cache.cwds([10]);
    advance(29_999);
    await cache.cwds([10]);
    expect(calls.length).toBe(1);
    advance(1);
    await cache.cwds([10]);
    expect(calls.length).toBe(2);
  });

  test("a pid that appears is asked for alone", async () => {
    const { cache, calls, advance } = harness({ 10: "/a", 11: "/b" });
    await cache.cwds([10]);
    advance(1_000);
    expect((await cache.cwds([10, 11])).get(11)).toBe("/b");
    expect(calls).toEqual([[10], [11]]);
  });

  test("concurrent readers share the read under way", async () => {
    const { cache, calls } = harness({ 10: "/a", 11: "/b" });
    const [a, b] = await Promise.all([cache.cwds([10, 11]), cache.cwds([11, 10])]);
    expect(calls.length).toBe(1);
    expect(a.get(10)).toBe("/a");
    expect(b.get(11)).toBe("/b");
  });

  test("a failed read caches nothing", async () => {
    let fail = true;
    const calls: number[][] = [];
    const cache = new ProcessCwdCache(async (pids) => {
      calls.push(pids);
      if (fail) throw new Error("lsof timed out");
      return lsofOut({ 10: "/a" }, pids);
    });
    expect((await cache.cwds([10])).get(10)).toBeNull();
    fail = false;
    expect((await cache.cwds([10])).get(10)).toBe("/a");
    expect(calls.length).toBe(2);
  });
});
