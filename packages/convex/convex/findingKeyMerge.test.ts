// The one-time evidence-key merge (findingKeyMerge.ts): copies of one message
// collapse onto the first filed, problems recount, and a problem left empty
// closes as the duplicate of the problem the message lives on.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";

const T0 = 1_760_000_000_000;

describe("mergeEvidenceKeys", () => {
  test("keeps the first filed copy, retires the rest, closes an emptied problem as a duplicate", async () => {
    const t = convexTest(schema, {
      "./_generated/server.ts": () => import("./_generated/server"),
      "./syncOutbox.ts": () => import("./syncOutbox"),
      "./findingKeyMerge.ts": () => import("./findingKeyMerge"),
      "./notificationRouter.ts": () => import("./notificationRouter"),
    });
    const { userId, ws } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "Finder" } as any);
      return { userId, ws: `user:${userId}` };
    });
    const ids = await t.run(async (ctx) => {
      const problem = (short: string, n: number, keys: string[], status = "open") => ctx.db.insert("tasks", {
        user_id: userId, workspace: ws, short_id: short, title: short, status, source: "signal", blocks: [], priority: "medium", task_type: "task",
        attempt_count: 0, retry_count: 0, max_retries: 3, cause: { signal_count: n, first_seen: T0, last_seen: T0, fingerprints: keys },
      } as any);
      const a = await problem("ct-1", 2, ["evidence:contact-conversation/c1:ex-3:aa", "evidence:contact-conversation/c1:ex-3:bb"]);
      const b = await problem("ct-2", 1, ["evidence:match/m1:ex-3:aa"]);
      const sig = (short: string, task: any, fingerprint: string, at: number) => ctx.db.insert("signals", {
        user_id: userId, workspace: ws, short_id: short, source: "judge:comms", kind: "prompt_miss", fingerprint, title: short, observed_at: at, created_at: at, task_id: task, attach: "similar",
      } as any);
      await sig("sg-1", a, "evidence:contact-conversation/c1:ex-3:aa", T0);
      await sig("sg-2", a, "evidence:contact-conversation/c1:ex-3:bb", T0 + 1);
      await sig("sg-3", b, "evidence:match/m1:ex-3:aa", T0 + 2);
      return { a, b };
    });
    const rows = [
      { signal: "sg-1", key: "evidence:contacts/c1:ex-3:aa" },
      { signal: "sg-2", key: "evidence:contacts/c1:ex-3:bb" },
      { signal: "sg-3", key: "evidence:contacts/c1:ex-3:aa" },
    ];
    const dry: any = await t.mutation(internal.findingKeyMerge.mergeEvidenceKeys, { workspace: ws, rows, actor: userId, dry_run: true });
    expect(dry).toEqual({ findings: 3, keys: 2, rekeyed: 3, retire: 1, across_problems: 1 });
    const r: any = await t.mutation(internal.findingKeyMerge.mergeEvidenceKeys, { workspace: ws, rows, actor: userId, dry_run: false });
    expect(r.closed).toEqual(["ct-2"]);
    const after = await t.run(async (ctx) => ({ a: await ctx.db.get(ids.a), b: await ctx.db.get(ids.b), sg3: await ctx.db.query("signals").withIndex("by_short_id", (q) => q.eq("short_id", "sg-3")).first() })) as any;
    expect(after.a.cause.fingerprints).toEqual(["evidence:contacts/c1:ex-3:aa", "evidence:contacts/c1:ex-3:bb"]);
    expect(after.a.cause.signal_count).toBe(2);
    expect(after.b.status).toBe("dropped");
    expect(after.b.duplicate_of).toBe("ct-1");
    expect(after.sg3.task_id).toBeUndefined();
    expect(after.sg3.retired.reason).toContain("sg-1");
  });
});
