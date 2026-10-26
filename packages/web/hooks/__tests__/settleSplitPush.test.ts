import { describe, expect, it } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { splitRows } from "@codecast/shared/contracts/inboxSplit";
import { rebuildSplitPayload, settleSplitPush } from "../useSplitQuery";

// A busy account pushes liveness every second or two, and a phone downloads the
// whole result slower than that. Each push supersedes the one before, so a
// download that only counted when it finished first never counted at all.
const NOW = 1_800_000_000_000;
const cold = (id: string) => ({ last_heartbeat: NOW - 60 * 60_000, n: id });
const hot = (id: string, beat: number) => ({ last_heartbeat: NOW - beat, n: id });

function liveness(rows: Record<string, any>) {
  const s = splitRows(Object.entries(rows), NOW);
  return { split: true, ids: s.ids, hot: Object.fromEntries(s.hot), cold_hash: s.cold_hash, projection: null };
}

describe("settleSplitPush", () => {
  it("keeps a superseded whole download, so the next push rebuilds", async () => {
    const q = makeFunctionReference<"query">("test:settleSplitPushSuperseded");
    let rows: Record<string, any> = { a: cold("a"), b: cold("b"), live: hot("live", 5_000) };
    const downloads: Array<() => void> = [];
    const convex = {
      query: (_q: any, _args: any) => {
        const whole = { liveness: { ...rows }, projection: null };
        return new Promise<any>((resolve) => downloads.push(() => resolve(whole)));
      },
    };

    // Push 1 cannot be rebuilt from an empty cache: it starts a download.
    let superseded1 = false;
    const first = settleSplitPush(convex, q, {}, "liveness", liveness(rows), () => superseded1);
    await Bun.sleep(0);
    expect(downloads.length).toBe(1);

    // A heartbeat lands and push 2 supersedes push 1 before its download finishes.
    rows = { ...rows, live: hot("live", 1_000) };
    superseded1 = true;
    downloads[0]();
    expect(await first).toBeNull();

    // Push 3 now rebuilds from the cache the superseded download filled.
    // The cold rows came only from that download: an empty cache cannot rebuild it.
    rows = { ...rows, live: hot("live", 0) };
    const third = liveness(rows);
    expect(rebuildSplitPayload("liveness", third, new Map())).toBeNull();
    const settled = await settleSplitPush(convex, q, {}, "liveness", third, () => false);
    expect(downloads.length).toBe(1);
    expect(settled).toEqual({ liveness: rows, projection: null });
  });
});
