import { describe, expect, test } from "bun:test";
import { refreshArmedTriggerKind } from "./agentTasks";
import { armedTriggerKindFor, isArmedTriggerHomeOfKind } from "./dormancy";
import { pinCapExceeded, INBOX_PINNED_CAP } from "./inboxProjection";
import { makeFakeDb } from "./testDb";
import type { Id } from "./_generated/dataModel";

// conversations.armed_trigger_kind is the denormalized answer the inbox
// projection reads instead of agent_tasks (sync-convergence C1). One writer
// (refreshArmedTriggerKind) recomputes it from every trigger injecting into the
// home; these pin the kind rule and that the writer only writes on change.

const CONV = "conversations_home" as Id<"conversations">;

function task(overrides: Record<string, any>) {
  return {
    _id: `agent_tasks_${Math.random().toString(36).slice(2, 8)}`,
    user_id: "users_me",
    originating_conversation_id: CONV,
    schedule_type: "once",
    status: "scheduled",
    ...overrides,
  };
}

describe("armedTriggerKindFor", () => {
  test("none without an armed inject trigger", () => {
    expect(armedTriggerKindFor([])).toBe("none");
    expect(armedTriggerKindFor([task({ status: "completed" })])).toBe("none");
    expect(armedTriggerKindFor([task({ originating_conversation_id: undefined })])).toBe("none");
    expect(armedTriggerKindFor([task({ last_run_failed: true })])).toBe("none");
    expect(armedTriggerKindFor([task({ last_run_needs_attention: true })])).toBe("none");
  });

  test("once for an armed once trigger; standing for recurring / event, and standing wins", () => {
    expect(armedTriggerKindFor([task({})])).toBe("once");
    expect(armedTriggerKindFor([task({ status: "paused" })])).toBe("once");
    expect(armedTriggerKindFor([task({ schedule_type: "recurring", interval_ms: 1000 })])).toBe("standing");
    expect(armedTriggerKindFor([task({ schedule_type: "event", status: "running" })])).toBe("standing");
    expect(armedTriggerKindFor([task({}), task({ schedule_type: "recurring" }), task({ status: "failed" })])).toBe("standing");
  });
});

describe("isArmedTriggerHomeOfKind", () => {
  test("matches the kind and keeps the machine-delivered-last-turn rule", () => {
    expect(isArmedTriggerHomeOfKind({ armed_trigger_kind: "standing" }, "standing")).toBe(true);
    expect(isArmedTriggerHomeOfKind({ armed_trigger_kind: "standing" }, "once")).toBe(false);
    expect(isArmedTriggerHomeOfKind({}, "standing")).toBe(false);
    expect(isArmedTriggerHomeOfKind({ armed_trigger_kind: "once", last_message_preview: "<session-message from=\"x\">hi</session-message>" }, "once")).toBe(true);
    expect(isArmedTriggerHomeOfKind({ armed_trigger_kind: "once", last_message_preview: "a human typed this" }, "once")).toBe(false);
  });
});

describe("refreshArmedTriggerKind", () => {
  test("stamps the home from its injecting triggers and writes only on change", async () => {
    const db = makeFakeDb({
      conversations: [{ _id: CONV, user_id: "users_me" }],
      agent_tasks: [task({ _id: "agent_tasks_a" }), task({ _id: "agent_tasks_b", schedule_type: "recurring" })],
    });
    await refreshArmedTriggerKind({ db }, CONV as any);
    expect((await db.get(CONV)).armed_trigger_kind).toBe("standing");
    expect(db._patched.length).toBe(1);
    // Unchanged: no second write (a write is a sync-log action).
    await refreshArmedTriggerKind({ db }, CONV as any);
    expect(db._patched.length).toBe(1);
    // Pause the standing loop: the once follow-up remains.
    await db.patch("agent_tasks_b", { status: "failed" });
    await refreshArmedTriggerKind({ db }, CONV as any);
    expect((await db.get(CONV)).armed_trigger_kind).toBe("once");
    // Cancel the last one: none.
    await db.patch("agent_tasks_a", { status: "completed" });
    await refreshArmedTriggerKind({ db }, CONV as any);
    expect((await db.get(CONV)).armed_trigger_kind).toBe("none");
  });

  test("a missing home is a no-op", async () => {
    const db = makeFakeDb({ conversations: [], agent_tasks: [task({})] });
    await refreshArmedTriggerKind({ db }, CONV as any);
    expect(db._patched.length).toBe(0);
  });
});

describe("pinCapExceeded", () => {
  const ME = "users_me";
  const pins = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: `conversations_${i}`, user_id: ME, inbox_pinned_at: 1000 + i }));

  test("only a NEW pin at the cap is refused", async () => {
    const full = { db: makeFakeDb({ conversations: pins(INBOX_PINNED_CAP) }) };
    expect(await pinCapExceeded(full, ME as any, { inbox_pinned_at: null }, { inbox_pinned_at: 5 })).toBe(true);
    // Re-pinning an already pinned row, or unpinning, never trips it.
    expect(await pinCapExceeded(full, ME as any, { inbox_pinned_at: 3 }, { inbox_pinned_at: 5 })).toBe(false);
    expect(await pinCapExceeded(full, ME as any, { inbox_pinned_at: 3 }, { inbox_pinned_at: undefined })).toBe(false);
    expect(await pinCapExceeded(full, ME as any, { inbox_pinned_at: null }, { title: "x" })).toBe(false);
    const room = { db: makeFakeDb({ conversations: pins(INBOX_PINNED_CAP - 1) }) };
    expect(await pinCapExceeded(room, ME as any, { inbox_pinned_at: null }, { inbox_pinned_at: 5 })).toBe(false);
  });
});

// ── webDelete restamps the old home ─────────────────────────────────────────

import { deleteTaskCascade } from "./agentTasks";

describe("deleteTaskCascade", () => {
  test("deleting the last armed trigger restamps the home to none, revisions included", async () => {
    const db = makeFakeDb({
      conversations: [{ _id: CONV, user_id: "users_me", armed_trigger_kind: "once" }],
      agent_tasks: [task({ _id: "agent_tasks_only" })],
      agent_task_revisions: [
        { _id: "agent_task_revisions_1", task_id: "agent_tasks_only" },
        { _id: "agent_task_revisions_2", task_id: "agent_tasks_other" },
      ],
    });
    const t = await db.get("agent_tasks_only");
    await deleteTaskCascade({ db }, t);
    expect(db._deleted).toContain("agent_tasks_only");
    expect(db._deleted).toContain("agent_task_revisions_1");
    expect(db._deleted).not.toContain("agent_task_revisions_2");
    expect((await db.get(CONV)).armed_trigger_kind).toBe("none");
  });

  test("deleting one of two triggers keeps the survivor's kind on the home", async () => {
    const db = makeFakeDb({
      conversations: [{ _id: CONV, user_id: "users_me", armed_trigger_kind: "standing" }],
      agent_tasks: [
        task({ _id: "agent_tasks_gone", schedule_type: "recurring" }),
        task({ _id: "agent_tasks_stays" }),
      ],
      agent_task_revisions: [],
    });
    await deleteTaskCascade({ db }, await db.get("agent_tasks_gone"));
    expect((await db.get(CONV)).armed_trigger_kind).toBe("once");
  });

  test("a task with no home is a plain delete", async () => {
    const db = makeFakeDb({
      conversations: [],
      agent_tasks: [task({ _id: "agent_tasks_free", originating_conversation_id: undefined })],
      agent_task_revisions: [],
    });
    await deleteTaskCascade({ db }, await db.get("agent_tasks_free"));
    expect(db._deleted).toEqual(["agent_tasks_free"]);
    expect(db._patched.length).toBe(0);
  });
});

// ── Exhaustive writer enumeration ───────────────────────────────────────────
//
// EVERY mutation that writes agent_tasks must restamp armed_trigger_kind on
// the home conversation (sync-convergence C1): the inbox classifies from the
// denormalized field and never reads agent_tasks, so a lifecycle write that
// skips the restamp parks or surfaces a session wrongly until some other
// transition happens to fix it. Statically enforced three ways:
//   1. the patchTask chokepoint is the only ctx.db.patch whose target is a
//      task and whose payload can carry an armed-relevant field;
//   2. inserts and deletes are single sites, each followed by the restamp;
//   3. the raw patch inventory is PINNED — a new raw ctx.db.patch site fails
//      this test until it is reviewed (route it through patchTask, or add it
//      here with a written reason it cannot change the armed answer).

import { readFileSync } from "fs";
import { join } from "path";

// The fields armedTriggerKindFor / isArmedInjectTrigger read: a write to any
// of these can change the home's answer.
const ARMED_RELEVANT = [
  "status", "schedule_type", "interval_ms", "event_filter",
  "last_run_failed", "last_run_needs_attention", "originating_conversation_id",
  "canceled_on_kill_at",
];

// Every `ctx.db.patch(…)` call in the file with its full, paren-balanced text.
function extractPatchCalls(src: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf("ctx.db.patch(", from);
    if (at === -1) break;
    let depth = 0;
    let end = at;
    for (let i = src.indexOf("(", at); i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    calls.push(src.slice(at, end));
    from = end;
  }
  return calls;
}

describe("every agent_tasks writer restamps the home (exhaustive)", () => {
  const src = readFileSync(join(import.meta.dir, "agentTasks.ts"), "utf8");
  const patchCalls = extractPatchCalls(src);

  test("the patchTask chokepoint exists and restamps", () => {
    expect(src).toContain("async function patchTask");
    expect(src).toMatch(/await ctx\.db\.patch\(task\._id, patch\);\s*\n\s*if \(task\.originating_conversation_id\) await refreshArmedTriggerKind\(ctx, task\.originating_conversation_id\);/);
  });

  test("no raw ctx.db.patch outside patchTask writes an armed-relevant field", () => {
    // The chokepoint's own call passes a variable payload; every OTHER call
    // must write only fields the armed answer never reads.
    const chokepoint = "ctx.db.patch(task._id, patch)";
    const offenders = patchCalls
      .filter((c) => c !== chokepoint)
      .filter((c) => ARMED_RELEVANT.some((f) => new RegExp(`[{,\\s]${f}\\s*:`).test(c)));
    expect(offenders).toEqual([]);
  });

  test("the raw patch inventory is pinned — a new site is a review event", () => {
    // Targets of every raw patch call, deduped. Conversation-row patches
    // (inbox stamps, agent_task_id backlink) and inert task-row fields
    // (created_by backlinks, short ids, display fields, event run_at pokes).
    const targets = patchCalls.map((c) => c.slice("ctx.db.patch(".length).split(",")[0].trim()).sort();
    expect([...new Set(targets)].sort()).toEqual([
      "args.task_id",       // created_by backlink repair + display summary (inert fields)
      "conv._id",           // conversation rows: agent_task_id backlink / un-stash
      "conversationId",     // refreshArmedTriggerKind's own conversation stamp
      "home._id",           // un-stash of a failed loop's home (conversation row)
      "prev._id",           // superseded run fold (conversation row)
      "runConv._id",        // run conversation fold (conversation row)
      "t._id",              // adminBackfillCreatedBy (inert field)
      "task._id",           // patchTask chokepoint + short-id/run_at inert sites
      "task.target_conversation_id", // target conversation bump (conversation row)
    ]);
  });

  test("insert and delete each pair with a restamp", () => {
    // One insert site (insertTask), restamped right after by its caller path.
    expect(src.match(/\.insert\("agent_tasks"/g)?.length).toBe(1);
    expect(src).toMatch(/await refreshArmedTriggerKind\(ctx, args\.originating_conversation_id as Id<"conversations">\);/);
    // One delete site (deleteTaskCascade), restamping the old home.
    const deleteSites = src.match(/ctx\.db\.delete\(task\._id\)/g) ?? [];
    expect(deleteSites.length).toBe(1);
    expect(src).toMatch(/await ctx\.db\.delete\(task\._id\);\s*\n\s*if \(task\.originating_conversation_id\) await refreshArmedTriggerKind\(ctx, task\.originating_conversation_id\);/);
    // webDelete routes through the cascade.
    expect(src).toMatch(/export const webDelete[\s\S]{0,400}deleteTaskCascade\(ctx, task\)/);
  });
});
