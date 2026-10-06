// Watch and learn (docs/architecture/the-line-end-to-end.md LE12), under
// convex-test: `cast task update --watch-days` sets the watch, the sweep
// closes a quiet one as resolved, and an answered card gate is recorded as a
// decision and, for Revise or Drop with a note, files a lesson signal through
// the signal door.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { pauseAtGateCore, answerGateCore } from "./workflow_runs";
import { finalizeAnswer, normalizeVerdict, settleClientResolution } from "./sessionDecisions";
import { gateNote, lessonFingerprint } from "./lineLearn";
import { verdictOfOption } from "@codecast/shared/contracts/changeCard";

const TOKEN = "w".repeat(64);
const DAY = 86_400_000;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./signals.ts": () => import("./signals"),
  "./tasks.ts": () => import("./tasks"),
  "./notificationRouter.ts": () => import("./notificationRouter"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Owner" } as any);
    await ctx.db.insert("api_tokens", { user_id: userId, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId, agent_type: "claude_code", session_id: "sess-line", started_at: now, updated_at: now,
      message_count: 0, is_private: true, status: "active", project_path: "/repo",
    } as any);
    const taskId = await ctx.db.insert("tasks", {
      user_id: userId, workspace: `user:${userId}`, short_id: "ct-7", title: "Checkout throws on empty cart",
      task_type: "bug", status: "in_progress", priority: "medium", blocks: [], source: "signal",
      attempt_count: 0, retry_count: 0, max_retries: 3, created_at: now, updated_at: now,
      cause: { signal_count: 2, first_seen: now - 3 * DAY, last_seen: now - 2 * DAY, fingerprints: ["err-1"] },
    } as any);
    return { userId, conversationId, taskId };
  });
  const task = () => t.run(async (ctx) => await ctx.db.get(ids.taskId)) as Promise<any>;
  return { t, ...ids, task, now };
}

describe("watch (LE12)", () => {
  test("--watch-days sets watch_until on the cause; 0 ends the watch", async () => {
    const { t, task } = await setup();
    const before = Date.now();
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-7", watch_days: 7 });
    const watched = await task();
    expect(watched.watch_until).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(watched.watch_until).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-7", watch_days: 0 });
    expect((await task()).watch_until).toBeUndefined();
    await expect(t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-7", watch_days: -1 })).rejects.toThrow("--watch-days");
  });

  test("a quiet watch that ended closes the cause as resolved, naming the window", async () => {
    const { t, taskId, task, now } = await setup();
    await t.run(async (ctx) => { await ctx.db.patch(taskId, { status: "in_review", watch_until: now - 1000 } as any); });
    const out = await t.mutation(internal.signals.sweepWatches, {});
    expect(out).toEqual({ closed: 1, more: false });
    const closed = await task();
    expect(closed.status).toBe("done");
    expect(closed.closed_at).toBeGreaterThan(0);
    expect(closed.watch_until).toBeUndefined();
    const { history, comments } = await t.run(async (ctx) => ({
      history: await ctx.db.query("task_history").collect(),
      comments: await ctx.db.query("task_comments").collect(),
    }));
    expect(history.some((h: any) => h.field === "status" && h.old_value === "in_review" && h.new_value === "done")).toBe(true);
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(comments.map((c: any) => c.text)).toEqual([`Watch ended quiet: no new signal from ${iso(now - 2 * DAY)} to ${iso(now - 1000)}.`]);
  });

  test("a cause already done keeps its close; a watch still running is left alone", async () => {
    const { t, taskId, task, now } = await setup();
    const closedAt = now - 5 * DAY;
    await t.run(async (ctx) => { await ctx.db.patch(taskId, { status: "done", closed_at: closedAt, watch_until: now + DAY } as any); });
    expect(await t.mutation(internal.signals.sweepWatches, {})).toEqual({ closed: 0, more: false });
    expect((await task()).watch_until).toBe(now + DAY);
    await t.run(async (ctx) => { await ctx.db.patch(taskId, { watch_until: now - 1 } as any); });
    await t.mutation(internal.signals.sweepWatches, {});
    const after = await task();
    expect(after).toMatchObject({ status: "done", closed_at: closedAt });
    expect(after.watch_until).toBeUndefined();
    expect(await t.run(async (ctx) => await ctx.db.query("task_history").collect())).toEqual([]);
  });

  test("a signal during watch reopens the cause, so the sweep has nothing to close", async () => {
    const { t, taskId, task, now } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, { status: "done", closed_at: now, watch_until: now + DAY } as any);
      const user = (await ctx.db.query("users").first())!;
      await ctx.db.insert("signals", {
        user_id: user._id, workspace: `user:${user._id}`, short_id: "sg-1", source: "sentry", kind: "bug",
        fingerprint: "err-1", title: "Checkout throws", observed_at: now, created_at: now, task_id: taskId, attach: "new",
      } as any);
    });
    const again = await t.action(api.signals.ingest, { api_token: TOKEN, workspace: "personal", source: "sentry", kind: "bug", fingerprint: "err-1", title: "Checkout throws" });
    expect(again).toMatchObject({ task_id: taskId, reopened: true });
    expect((await task()).status).toBe("open");
    expect(await t.mutation(internal.signals.sweepWatches, {})).toEqual({ closed: 0, more: false });
  });
});

const CARD_CHOICES = [
  { key: "S", label: "[S] Ship", target: "merge" },
  { key: "R", label: "[R] Revise", target: "implement" },
  { key: "D", label: "[D] Drop", target: "exit" },
];

/** A line run paused at a gate, through the real pause path (askCore). */
async function pausedAt(nodeId: string) {
  const env = await setup();
  const { t, userId, conversationId, taskId, now } = env;
  const runId = await t.run(async (ctx) => {
    const workflowId = await ctx.db.insert("workflows", { user_id: userId, name: "line", slug: "line", nodes: [], edges: [], created_at: now, updated_at: now } as any);
    const runId = await ctx.db.insert("workflow_runs", {
      user_id: userId, workflow_id: workflowId, task_id: taskId, status: "running", node_statuses: [],
      workspace: `user:${userId}`, spawner_conversation_id: conversationId, created_at: now, updated_at: now,
    } as any);
    const paused = await pauseAtGateCore(ctx as any, { userId }, { run_id: runId, node_id: nodeId, prompt: "Ship ct-7: Checkout throws on empty cart?", choices: CARD_CHOICES });
    expect(paused).toMatchObject({ ok: true });
    return runId;
  });
  const decision = () => t.run(async (ctx) => await ctx.db.query("session_decisions").first()) as Promise<any>;
  const read = () => t.run(async (ctx) => ({
    decisions: await ctx.db.query("decisions").collect(),
    signals: await ctx.db.query("signals").collect(),
    tasks: await ctx.db.query("tasks").collect(),
    run: await ctx.db.get(runId),
  }));
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 30));
    await t.finishInProgressScheduledFunctions();
  };
  return { ...env, runId, decision, read, settle };
}

describe("learn (LE12)", () => {
  test("Revise with a note: a recorded decision, and a lesson signal through the door", async () => {
    const { t, userId, decision, read, settle } = await pausedAt("decide");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("session_decisions").first();
      const verdict = normalizeVerdict(row as any, { status: "answered", answer_index: 1, answer_text: "Add a test for the empty cart before the fix" });
      await finalizeAnswer(ctx as any, row as any, verdict as any, { kind: "user", id: String(userId), user_id: userId }, { deliver: false });
    });
    await settle();
    const { decisions, signals, tasks, run } = await read();
    expect(run).toMatchObject({ status: "running", gate_response: "R: Add a test for the empty cart before the fix" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      user_id: userId,
      workspace: `user:${userId}`,
      title: "Ship ct-7: Checkout throws on empty cart?",
      rationale: "Revise: Add a test for the empty cart before the fix Task ct-7.",
      alternatives: ["Ship", "Drop"],
      tags: ["line", "card:revise", "ct-7"],
      session_id: "sess-line",
      project_path: "/repo",
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: "lesson",
      kind: "cohesion",
      fingerprint: lessonFingerprint("ct-7", "Add a test for the empty cart before the fix"),
      subject: "ct-7",
      workspace: `user:${userId}`,
      attach: "new",
    });
    expect(signals[0].fingerprint).toMatch(/^lesson:ct-7:[0-9a-f]{8}$/);
    expect(signals[0].detail_md).toStartWith("Add a test for the empty cart before the fix");
    const lessonCause = tasks.find((x: any) => String(x._id) === String(signals[0].task_id));
    expect(lessonCause).toMatchObject({ source: "signal", triage_status: "suggested" });
    expect((await decision()).status).toBe("answered");
  });

  test("the lesson files into the answered cause's project (LP1)", async () => {
    const { t, userId, taskId, decision, read, settle } = await pausedAt("decide");
    const projectId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("projects", { user_id: userId, workspace: `user:${userId}`, title: "Checkout", status: "active", created_at: Date.now(), updated_at: Date.now() } as any);
      await ctx.db.patch(taskId, { project_id: id } as any);
      return id;
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("session_decisions").first();
      const verdict = normalizeVerdict(row as any, { status: "answered", answer_index: 2, answer_text: "the cart is being rewritten anyway" });
      await finalizeAnswer(ctx as any, row as any, verdict as any, { kind: "user", id: String(userId), user_id: userId }, { deliver: false });
    });
    await settle();
    const { signals, tasks } = await read();
    expect(signals).toHaveLength(1);
    expect(signals[0].project_id).toBe(projectId);
    expect(tasks.find((x: any) => String(x._id) === String(signals[0].task_id))?.project_id).toBe(projectId);
    expect((await decision()).status).toBe("answered");
  });

  test("Drop from the run panel: the key in front of the note is not part of it", async () => {
    const { t, userId, runId, read, settle } = await pausedAt("decide");
    await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      const out = await answerGateCore(ctx as any, run, "D: the cart is being rewritten anyway", { kind: "user", id: String(userId), user_id: userId });
      expect(out).toEqual({ ok: true });
    });
    await settle();
    const { decisions, signals } = await read();
    expect(decisions[0]).toMatchObject({ rationale: "Drop: the cart is being rewritten anyway Task ct-7.", tags: ["line", "card:drop", "ct-7"] });
    expect(signals.map((s: any) => s.fingerprint)).toEqual([lessonFingerprint("ct-7", "the cart is being rewritten anyway")]);
  });

  test("the web's answer (settleClientResolution) learns the same way", async () => {
    const { t, userId, read, settle } = await pausedAt("decide");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("session_decisions").first();
      const patch = { status: "answered", answer_index: 1, answer_text: "Name the instruction line that caused it" };
      await ctx.db.patch(row!._id, patch as any);
      await settleClientResolution(ctx as any, row as any, patch, userId, Date.now());
    });
    await settle();
    const { decisions, signals } = await read();
    expect(decisions).toHaveLength(1);
    expect(signals).toHaveLength(1);
  });

  test("Ship, and Revise without a note, are recorded but file no lesson", async () => {
    for (const [index, text, word] of [[0, undefined, "Ship."], [1, "R", "Revise."]] as const) {
      const { t, userId, read, settle } = await pausedAt("decide");
      await t.run(async (ctx) => {
        const row = await ctx.db.query("session_decisions").first();
        const verdict = normalizeVerdict(row as any, { status: "answered", answer_index: index, answer_text: text });
        await finalizeAnswer(ctx as any, row as any, verdict as any, { kind: "user", id: String(userId), user_id: userId }, { deliver: false });
      });
      await settle();
      const { decisions, signals } = await read();
      expect(decisions.map((d: any) => d.rationale)).toEqual([`${word} Task ct-7.`]);
      expect(signals).toEqual([]);
    }
  });

  test("a gate that is not the card's records nothing", async () => {
    const { t, userId, read, settle } = await pausedAt("plan");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("session_decisions").first();
      const verdict = normalizeVerdict(row as any, { status: "answered", answer_index: 1, answer_text: "smaller scope" });
      await finalizeAnswer(ctx as any, row as any, verdict as any, { kind: "user", id: String(userId), user_id: userId }, { deliver: false });
    });
    await settle();
    const { decisions, signals } = await read();
    expect(decisions).toEqual([]);
    expect(signals).toEqual([]);
  });
});

describe("the pure parts", () => {
  test("gateNote drops the key and the option's word, keeps the note", () => {
    expect(gateNote("R: add a test", "R", "[R] Revise")).toBe("add a test");
    expect(gateNote("[R] add a test", "R", "[R] Revise")).toBe("add a test");
    expect(gateNote("Revise: add a test", "R", "[R] Revise")).toBe("add a test");
    expect(gateNote("R", "R", "[R] Revise")).toBe("");
    expect(gateNote("Rewrite the prompt", "R", "[R] Revise")).toBe("Rewrite the prompt");
    expect(gateNote(undefined, "R", "Revise")).toBe("");
  });

  test("verdictOfOption reads the option's word", () => {
    expect(verdictOfOption("[R] Revise")).toBe("revise");
    expect(verdictOfOption("Drop the change")).toBe("drop");
    expect(verdictOfOption("Ship")).toBe("ship");
    expect(verdictOfOption("Shipping later")).toBeNull();
    expect(verdictOfOption(undefined)).toBeNull();
  });

  test("the lesson fingerprint ignores case and spacing", () => {
    expect(lessonFingerprint("ct-7", "Add a  test\n")).toBe(lessonFingerprint("ct-7", "add a test"));
    expect(lessonFingerprint("ct-7", "add a test")).not.toBe(lessonFingerprint("ct-8", "add a test"));
  });
});
