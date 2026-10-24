// A finding from after a dissolved problem's fix reopens it; one that cannot
// date what it saw never does (findingGroups.evidenceAt), and the repairs that
// put back problems such findings reopened (signalRepairs.ts).
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";

const TOKEN = "s".repeat(64);
const T0 = 1_760_000_000_000;

async function setup() {
  const t = convexTest(schema, {
    "./_generated/server.ts": () => import("./_generated/server"),
    "./syncOutbox.ts": () => import("./syncOutbox"),
    "./signals.ts": () => import("./signals"),
    "./signalRepairs.ts": () => import("./signalRepairs"),
    "./notificationRouter.ts": () => import("./notificationRouter"),
  });
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { name: "Finder" } as any);
    await ctx.db.insert("api_tokens", { user_id: id, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    await ctx.db.insert("projects", {
      user_id: id, workspace: `user:${id}`, short_id: "pr-1", title: "Web", status: "active", created_at: T0, updated_at: T0,
      line_profile: { finders: [{ id: "errors", source: "sentry", kind: ["bug"], fingerprint: "<group>", opens_causes: true }], changed_at: T0 },
    } as any);
    return id;
  });
  const add = (fields: Record<string, any>) =>
    t.action(api.signals.ingest, { api_token: TOKEN, workspace: "personal", source: "sentry", kind: "bug", ...fields } as any);
  const task = (id: string) => t.run(async (ctx) => await ctx.db.get(id as any)) as Promise<any>;
  return { t, userId, add, task };
}

describe("a finding from after a dissolved problem's fix reopens it", () => {
  const FIXED = T0 + 5_000;
  const CLOSED = T0 + 10_000;
  async function fixedProblem(t: Awaited<ReturnType<typeof setup>>["t"], userId: any) {
    return await t.run(async (ctx) => await ctx.db.insert("tasks", {
      user_id: userId, workspace: `user:${userId}`, short_id: "ct-9", title: "Fee volunteered unasked", status: "done", closed_at: CLOSED,
      source: "signal", blocks: [], priority: "medium", task_type: "task", attempt_count: 0, retry_count: 0, max_retries: 3,
      cause: { signal_count: 2, first_seen: T0, last_seen: T0, fingerprints: ["k-1"], dissolved: { at: CLOSED, note: "Already fixed since the fee commit.", fixed_at: FIXED } },
    } as any));
  }
  const finding = (observed_at: number) => ({ source: "person", kind: "prompt_miss", fingerprint: `k-${observed_at}`, title: "Fee raised unasked", observed_at });

  test("before the fix it is absorbed; after the fix, though before the close, it reopens the problem", async () => {
    const { t, userId, task } = await setup();
    const taskId = await fixedProblem(t, userId);
    const early: any = await t.mutation(internal.signals.commit, { user_id: userId, signal: finding(FIXED - 1), workspace: "personal", judged_task_id: taskId } as any);
    expect(early.task_id).toBe(taskId);
    expect((await task(taskId)).status).toBe("done");
    const late: any = await t.mutation(internal.signals.commit, { user_id: userId, signal: finding(FIXED + 1), workspace: "personal", judged_task_id: taskId } as any);
    expect(late.task_id).toBe(taskId);
    expect(late.reopened).toBe(true);
    const reopened = await task(taskId);
    expect(reopened.status).toBe("open");
    expect(reopened.cause.dissolved).toBeUndefined();
    const notes = await t.run(async (ctx) => await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", taskId)).collect());
    expect(notes.map((n: any) => n.text).join("\n")).toContain("did not hold");
  });

  test("a move onto it reopens it instead of parking the finding closed", async () => {
    const { t, userId, task } = await setup();
    const taskId = await fixedProblem(t, userId);
    const late: any = await t.mutation(internal.signals.commit, { user_id: userId, signal: finding(FIXED + 1), workspace: "personal" } as any);
    expect(late.task_id).not.toBe(taskId);
    const moved: any = await t.mutation(api.signals.moveForCli, { api_token: TOKEN, fingerprint: `k-${FIXED + 1}`, from: late.task_short_id, to: "ct-9" } as any);
    expect(moved.to).toBe("ct-9");
    expect(moved.refused).toBeUndefined();
    expect((await task(taskId)).status).toBe("open");
  });

  test("an undated finding (a bulk review of a whole history) is answered by the reason, never a recurrence", async () => {
    const { t, userId, task } = await setup();
    const taskId = await fixedProblem(t, userId);
    const undated: any = await t.mutation(internal.signals.commit, { user_id: userId, signal: { ...finding(FIXED + 1), happened_after: 0 }, workspace: "personal", judged_task_id: taskId } as any);
    expect(undated.task_id).toBe(taskId);
    expect(undated.reopened).toBe(false);
    const still = await task(taskId);
    expect(still.status).toBe("done");
    expect(still.cause.dissolved.fixed_at).toBe(FIXED);
  });

  test("restoreUndatedReopens puts back a problem an undatable bulk finding reopened, and leaves a real recurrence", async () => {
    const { t, userId, task } = await setup();
    const commit = (signal: any, judged?: any) => t.mutation(internal.signals.commit, { user_id: userId, signal, workspace: "personal", ...(judged ? { judged_task_id: judged } : {}) } as any) as Promise<any>;
    const sourceId = await t.run(async (ctx) => await ctx.db.insert("event_sources", { workspace: `user:${userId}`, name: "app", owner_user_id: userId, created_at: T0 } as any));
    await t.run(async (ctx) => {
      for (const [short_id, batch] of [["mo-1", "d60"], ["mo-2", undefined]] as const) {
        await ctx.db.insert("moments", { workspace: `user:${userId}`, source_id: sourceId, short_id, kind: "conversation", subject: "c_1", status: "ready", events: 1, first_event_at: T0, event_at: T0, due_at: T0, attempts: 0, created_at: T0, updated_at: T0, ...(batch ? { batch } : {}) } as any);
      }
    });
    const opened = [await commit(finding(T0)), await commit({ ...finding(T0 + 1), fingerprint: "k-other" })];
    const fixedAt = Date.parse("2026-01-02T08:00:00Z");
    for (const o of opened) await t.mutation(api.signals.dissolveForCli, { api_token: TOKEN, task: o.task_short_id, outcome: "done", note: "Already fixed by abc1234.", fixed_at: fixedAt } as any);
    // Filed before findings of a bulk review carried happened_after: dated by when the review read it, after the fix.
    const later = fixedAt + 30 * 86_400_000;
    await commit({ ...finding(later), fingerprint: "k-bulk", moment: "mo-1" }, opened[0].task_id);
    await commit({ ...finding(later), fingerprint: "k-live", moment: "mo-2" }, opened[1].task_id);
    expect((await task(opened[0].task_id)).status).toBe("open");
    expect((await task(opened[1].task_id)).status).toBe("open");

    const refs = opened.map((o) => o.task_short_id);
    const dry: any[] = await t.mutation(internal.signalRepairs.restoreUndatedReopens, { workspace: `user:${userId}`, tasks: refs, dry: true });
    expect(dry).toEqual([
      expect.objectContaining({ task: refs[0], restored: false, moment: "mo-1", fixed_at: "2026-01-02T23:59:59.999Z", note: "Already fixed by abc1234." }),
      expect.objectContaining({ task: refs[1], restored: false, why: expect.stringContaining("a real recurrence") }),
    ]);
    expect((await task(opened[0].task_id)).status).toBe("open");

    const done: any[] = await t.mutation(internal.signalRepairs.restoreUndatedReopens, { workspace: `user:${userId}`, tasks: refs });
    expect(done[0]).toMatchObject({ restored: true });
    const back = await task(opened[0].task_id);
    expect(back.status).toBe("done");
    expect(back.cause.dissolved).toMatchObject({ note: "Already fixed by abc1234.", fixed_at: Date.parse("2026-01-02T23:59:59.999Z") });
    expect((await task(opened[1].task_id)).status).toBe("open");
    const bulk = await t.run(async (ctx) => (await ctx.db.query("signals").collect()).find((r: any) => r.fingerprint === "k-bulk")) as any;
    expect(bulk).toMatchObject({ happened_after: 0 });
    expect(bulk.reopened).toBeUndefined();
    const notes = await t.run(async (ctx) => await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", opened[0].task_id)).collect());
    expect(notes.at(-1)!.text).toStartWith("Reopen undone:");
    // Run twice, it changes nothing more.
    expect((await t.mutation(internal.signalRepairs.restoreUndatedReopens, { workspace: `user:${userId}`, tasks: [refs[0]] }))[0]).toMatchObject({ restored: false });

    // The rest of a bulk review's findings filed before: stamped undated; a live moment's are left as they are.
    await commit({ ...finding(later + 1), fingerprint: "k-bulk-2", moment: "mo-1" });
    const ws = `user:${userId}`;
    expect(await t.mutation(internal.signalRepairs.stampUndatedFindings, { workspace: ws, dry: true })).toMatchObject({ stamped: 1, cursor: null });
    expect(await t.mutation(internal.signalRepairs.stampUndatedFindings, { workspace: ws })).toMatchObject({ stamped: 1 });
    const rows = await t.run(async (ctx) => await ctx.db.query("signals").collect()) as any[];
    expect(rows.find((r) => r.fingerprint === "k-bulk-2").happened_after).toBe(0);
    expect(rows.find((r) => r.fingerprint === "k-live").happened_after).toBeUndefined();
    expect(await t.mutation(internal.signalRepairs.stampUndatedFindings, { workspace: ws })).toMatchObject({ stamped: 0 });
  });

  test("cast line dissolve keeps the fix time it is given", async () => {
    const { t, task } = await setup();
    const opened: any = await t.mutation(internal.signals.commit, { user_id: (await t.run(async (ctx) => (await ctx.db.query("users").first())!._id)), signal: finding(T0), workspace: "personal" } as any);
    await t.mutation(api.signals.dissolveForCli, { api_token: TOKEN, task: opened.task_short_id, outcome: "done", note: "Already fixed by abc1234.", fixed_at: FIXED } as any);
    expect((await task(opened.task_id)).cause.dissolved.fixed_at).toBe(FIXED);
  });
});
