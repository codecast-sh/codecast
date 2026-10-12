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

  // pl-882 round 18: ct-59267's title narrowed to "Callback contacts hear a
  // stranger" and the attach judge turned 65 same-mechanism calls away from it.
  test("a candidate carries its first standing findings, what happened and the line quoted", async () => {
    const t = convexTest(schema, { "./_generated/server.ts": () => import("./_generated/server"), "./findingGroups.ts": () => import("./findingGroups") });
    const ids = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Ana" } as any);
      const ws = `user:${user}`;
      const task = await ctx.db.insert("tasks", {
        user_id: user, workspace: ws, short_id: "ct-1", title: "Callback contacts hear a stranger", status: "in_review", priority: "medium", blocks: [], source: "signal",
        cause: { signal_count: 5, first_seen: T0, last_seen: T0, fingerprints: [] }, attempt_count: 0, retry_count: 0, max_retries: 3, created_at: T0, updated_at: T0,
      } as any);
      const vectors = [];
      for (let i = 1; i <= 5; i++) {
        const id = await ctx.db.insert("signals", {
          user_id: user, workspace: ws, short_id: `sg-${i}`, source: "judge:call", kind: "prompt_miss", fingerprint: `k-${i}`, title: `Caller ${i} named only the company.`,
          detail_md: `Caller ${i} named only the company.\n\n> Hi, this is Union\n> calling about your search`, subject: "ex-34", observed_at: T0, created_at: T0 + i, attach: "new", task_id: task,
          ...(i === 1 ? { judge_review: { verdict: "wrong" } } : {}),
        } as any);
        vectors.push(await ctx.db.insert("signal_vectors", { workspace: ws, scope: `${ws}|ex-34`, signal_id: id, embedding: new Array(FINDING_VECTOR_DIMENSIONS).fill(0.01) } as any));
      }
      return { ws, hit: vectors[4]! };
    });
    const [c] = await t.query(internal.findingGroups.causesForHits, { workspace: ids.ws, hits: [{ id: ids.hit, score: 0.7 }] });
    expect(c!.findings).toEqual([2, 3, 4].map((i) => ({ what: `Caller ${i} named only the company.`, quote: "Hi, this is Union calling about your search" })));
  });
});
