import { describe, expect, it } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { splitRows } from "@codecast/shared/contracts/inboxSplit";
import { settleSplitPush } from "../useSplitQuery";

// The live-update freeze of ct-98162: on a large account a split inbox push the
// cache cannot vouch for fetches the whole list, and the code after that fetch
// runs inside the WebSocket message that delivered it. It hashed every cold row
// (a sorted-key stringify of megabytes) in that one task, so the page froze for
// half a second, again on every push whose cold rows the cache had lost.
//
// The fixture is the size the recording's account sent: 2,000 inbox rows of
// about 2 kB each, around 4 MB, the 3.5 MB list measured on 2026-10-08.
const NOW = Date.now();
const COLD = NOW - 60 * 60_000;
function inboxRow(i: number, stamp: number): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (let k = 0; k < 60; k++) fields[`field_${k}`] = k % 3 ? `v${k}-${i}` : { a: k, b: [1, 2, { c: "d" }] };
  return {
    _id: `jx7${String(i).padStart(29, "0")}`, title: `Session ${i}: fix the sync race`, updated_at: stamp - i * 1000,
    message_count: 200 + i, project_path: `/src/p${i % 40}`, activity: { text: "editing", tool: "Edit" },
    git: { branch: "main", sha: "abcdef0", files: Array.from({ length: 10 }, (_, f) => `file${f}.ts`) }, ...fields,
  };
}
const ROWS = 2000;
const LONG_TASK_MS = 50;

describe("a live inbox push on a large account (ct-98162)", () => {
  it(`settles a push that needs the whole list without blocking the page longer than ${LONG_TASK_MS} ms`, async () => {
    const q = makeFunctionReference<"query">("test:splitSettleLongTask");
    const rows = Array.from({ length: ROWS }, (_, i) => inboxRow(i, i < 20 ? NOW : COLD));
    const s = splitRows(rows.map((r) => [r._id as string, r]), NOW);
    const push = { split: true, ids: s.ids, hot: s.hot.map(([, r]) => r), cold_hash: s.cold_hash, hidden_count: 0, truncated: false };
    // The whole list as the socket hands it over: fresh objects, decoded before
    // the message's handlers run, so the decode is not the code under test.
    const whole = structuredClone({ sessions: rows, hidden_count: 0, truncated: false });
    const convex = { query: () => new Promise<any>((resolve) => setTimeout(() => resolve(whole), 0)) };

    let last = performance.now();
    let longest = 0;
    let beating = true;
    const beat = () => {
      const t = performance.now();
      longest = Math.max(longest, t - last);
      last = t;
      if (beating) setTimeout(beat, 0);
    };
    setTimeout(beat, 0);
    const settled = await settleSplitPush(convex, q, {}, "list", push, () => false);
    beating = false;
    beat();

    console.log(`settled ${settled?.sessions?.length} rows; longest block ${longest.toFixed(0)} ms`);
    expect(settled.sessions.length).toBe(ROWS);
    expect(settled.sessions.map((r: any) => r._id)).toEqual(s.ids);
    expect(longest).toBeLessThan(LONG_TASK_MS);
  });
});
