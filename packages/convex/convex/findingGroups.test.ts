import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { FINDING_VECTOR_DIMENSIONS } from "./momentsSchema";

const T0 = Date.UTC(2026, 9, 12);

// A problem in review whose findings a newer judge withdrew keeps its card,
// and stays the home of what reads the same (pl-882: ct-59231 held 0 live
// findings while ct-59534 opened beside it for the same persona switch).
describe("causesForHits", () => {
  test("a withdrawn finding names the open problem it was on; one whose problem closed, or a merged key, names none", async () => {
    const t = convexTest(schema, { "./_generated/server.ts": () => import("./_generated/server"), "./findingGroups.ts": () => import("./findingGroups") });
    const ids = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Ana" } as any);
      const ws = `user:${user}`;
      const problem = (short_id: string, status: string) => ctx.db.insert("tasks", {
        user_id: user, workspace: ws, short_id, title: `Problem ${short_id}`, status, priority: "medium", blocks: [], source: "signal",
        cause: { signal_count: 1, first_seen: T0, last_seen: T0, fingerprints: [] }, attempt_count: 0, retry_count: 0, max_retries: 3, created_at: T0, updated_at: T0,
      } as any);
      const inReview = await problem("ct-1", "in_review");
      const dropped = await problem("ct-2", "dropped");
      const other = await problem("ct-3", "open");
      const finding = async (short_id: string, fields: Record<string, any>) => {
        const id = await ctx.db.insert("signals", {
          user_id: user, workspace: ws, short_id, source: "judge:comms", kind: "prompt_miss", fingerprint: `k-${short_id}`, title: "Signed by another rep",
          subject: "ex-16", observed_at: T0, created_at: T0, attach: "new", ...fields,
        } as any);
        return await ctx.db.insert("signal_vectors", { workspace: ws, scope: `${ws}|ex-16`, signal_id: id, embedding: new Array(FINDING_VECTOR_DIMENSIONS).fill(0.01) } as any);
      };
      return {
        ws,
        withdrawnOpen: await finding("sg-1", { retired: { at: T0, reason: "judged again", task_id: inReview } }),
        withdrawnClosed: await finding("sg-2", { retired: { at: T0, reason: "judged again", task_id: dropped } }),
        merged: await finding("sg-3", { task_id: other, merged_into: "k-other" }),
      };
    });
    const candidates = await t.query(internal.findingGroups.causesForHits, {
      workspace: ids.ws,
      observed_at: T0 + 1,
      hits: [
        { id: ids.withdrawnOpen, score: 0.9 },
        { id: ids.withdrawnClosed, score: 0.95 },
        { id: ids.merged, score: 0.97 },
      ],
    });
    expect(candidates.map((c) => c.short_id)).toEqual(["ct-1"]);
    expect(candidates[0].score).toBe(0.9);
  });
});
