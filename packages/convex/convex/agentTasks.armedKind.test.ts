import { describe, expect, test } from "bun:test";
import { refreshArmedTriggerKind } from "./agentTasks";
import { armedTriggerKindFor, isArmedTriggerHomeOfKind } from "./dormancy";
import { pinCapExceeded, INBOX_PINNED_CAP } from "./inboxProjection";
import { makeFakeDb } from "./testDb";

// conversations.armed_trigger_kind is the denormalized answer the inbox
// projection reads instead of agent_tasks (sync-convergence C1). One writer
// (refreshArmedTriggerKind) recomputes it from every trigger injecting into the
// home; these pin the kind rule and that the writer only writes on change.

const CONV = "conversations_home";

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
