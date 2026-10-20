// Turning a finder off (judgeRetire.retireBefore): its findings from before a
// cutoff retire with the reason given, each keeping the problem it left; a
// problem left holding none closes as dropped with that reason, a run working
// it or not; a finding from after the cutoff, or from another finder, stays,
// and so does its problem. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";

const T0 = Date.now() - 10_000;
const CUT = T0 + 5_000;
const REASON = "the finder that filed it was turned off";

async function setup() {
  const t = convexTest(schema, {
    "./_generated/server.ts": () => import("./_generated/server"),
    "./syncOutbox.ts": () => import("./syncOutbox"),
    "./signals.ts": () => import("./signals"),
    "./judgeRetire.ts": () => import("./judgeRetire"),
    "./notificationRouter.ts": () => import("./notificationRouter"),
  });
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const ws = `user:${user}`;
    const project = await ctx.db.insert("projects", { user_id: user, workspace: ws, short_id: "pr-1", title: "Quality", status: "active", created_at: T0, updated_at: T0 } as any);
    const problem = (short: string, status: string, n: number, at = T0) => ctx.db.insert("tasks", {
      user_id: user, workspace: ws, short_id: short, title: `Problem ${short}`, status, priority: "medium", blocks: [], source: "signal", project_id: project,
      cause: { signal_count: n, first_seen: at, last_seen: at, fingerprints: [`k:${short}`] }, attempt_count: 0, retry_count: 0, max_retries: 3, created_at: at, updated_at: at,
    } as any);
    const finding = (short: string, task: any, source: string, at = T0) => ctx.db.insert("signals", {
      user_id: user, workspace: ws, short_id: short, source, kind: "prompt_miss", fingerprint: `k:${short}`, title: `Finding ${short}`,
      observed_at: at, created_at: at, task_id: task, project_id: project, attach: "fingerprint",
    } as any);
    const open = await problem("ct-1", "open", 2);
    await finding("sg-1", open, "judge:comms");
    await finding("sg-2", open, "judge:comms");
    const review = await problem("ct-2", "in_review", 1);
    await finding("sg-3", review, "judge:call");
    const mixed = await problem("ct-3", "open", 2);
    await finding("sg-4", mixed, "agentwatch");
    await finding("sg-5", mixed, "person");
    const late = await problem("ct-4", "open", 2);
    await finding("sg-6", late, "agentwatch");
    await finding("sg-7", late, "agentwatch", CUT + 1);
    const empty = await problem("ct-5", "open", 0);
    const after = await problem("ct-6", "open", 1, CUT + 1);
    await finding("sg-8", after, "agentwatch", CUT + 1);
    return { user, open, review, mixed, late, empty, after };
  });
  const get = (id: any) => t.run(async (ctx) => await ctx.db.get(id)) as Promise<any>;
  const signal = (short: string) => t.run(async (ctx) => await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", short)).first()) as Promise<any>;
  const retire = (tasks: string[], dry: boolean, sources?: string[]) =>
    t.mutation((internal as any).judgeRetire.retireBefore, { tasks, before: CUT, reason: REASON, actor: ids.user, dry, ...(sources ? { sources } : {}) });
  return { t, ...ids, get, signal, retire };
}

describe("retiring a finder's work from before a cutoff", () => {
  test("a dry run reports and writes nothing", async () => {
    const s = await setup();
    const r = await s.retire(["ct-1", "ct-2"], true);
    expect(r).toEqual([
      { task: "ct-1", was: "open", retired: ["sg-1", "sg-2"], kept: [], closed: true },
      { task: "ct-2", was: "in_review", retired: ["sg-3"], kept: [], closed: true },
    ]);
    expect((await s.get(s.open)).status).toBe("open");
    expect((await s.signal("sg-1")).retired).toBeUndefined();
  });

  test("old findings retire keeping their problem, and a problem left with none closes as dropped with the reason, a run at its gate or not", async () => {
    const s = await setup();
    await s.retire(["ct-1", "ct-2", "ct-5"], false);
    const sg1 = await s.signal("sg-1");
    expect(sg1.task_id).toBeUndefined();
    expect(sg1.retired).toMatchObject({ reason: REASON, task_id: s.open });
    expect(await s.get(s.open)).toMatchObject({ status: "dropped", cause: { signal_count: 0 } });
    expect(await s.get(s.review)).toMatchObject({ status: "dropped", cause: { dissolved: { note: `Closed: ${REASON}.` } } });
    expect((await s.get(s.empty)).status).toBe("dropped");
    const notes = await s.t.run(async (ctx) => (await ctx.db.query("task_comments").collect()).map((c: any) => c.text));
    expect(notes).toContain(`Closed: none of its 2 findings stands any more (${REASON}).`);
    expect(notes).toContain(`Closed: ${REASON}.`);
  });

  test("another finder's findings, and anything from after the cutoff, stay with their problems", async () => {
    const s = await setup();
    const r = await s.retire(["ct-3", "ct-4", "ct-6"], false, ["agentwatch"]);
    expect(r).toEqual([
      { task: "ct-3", was: "open", retired: ["sg-4"], kept: ["sg-5"], closed: false },
      { task: "ct-4", was: "open", retired: ["sg-6"], kept: ["sg-7"], closed: false },
      { task: "ct-6", was: "open", retired: [], kept: [], closed: false, skipped: "filed after the cutoff" },
    ]);
    expect(await s.get(s.mixed)).toMatchObject({ status: "open", cause: { signal_count: 1 } });
    expect((await s.get(s.late)).status).toBe("open");
    expect((await s.signal("sg-7")).retired).toBeUndefined();
    expect((await s.signal("sg-8")).task_id).toBe(s.after);
  });
});
