import { describe, expect, test } from "bun:test";
import { parseScheduledTask } from "@codecast/shared/contracts";
import { performNeedsInputCheck } from "./notifications";
import { performApplyOwnersChange } from "./sessionOwnership";
import { computeInboxSessions } from "./conversations";
import { createCtx, settledIdleWorld, type Rec } from "./notifications.needsInput.testkit";
import { makeFakeDb } from "./testDb";

// A waiting session dropped onto another (adopt_parent) hands its standing
// wait to the session it now works for: the stamps its old owners left (an
// escalation to the dragger, the episode key) come off, the needs-input check
// runs again and tells the new parent, and the dragger's inbox lets it go.
describe("an adopt hands a standing wait to the new parent", () => {
  const now = Date.now();
  const blocked = { short_id: "jx7wait", team_id: "team1", is_private: false, thread_state_status: "blocked", thread_state: "Which price band for Texas?", thread_state_at: now - 30_000 };
  const told = (tables: Record<string, Rec[]>, conv: string) => (tables.pending_messages ?? []).filter((m) => m.conversation_id === conv).map((m) => parseScheduledTask(m.content)).filter(Boolean);

  const world = (escalated: boolean) => {
    const w = settledIdleWorld({
      conv: {
        ...blocked,
        ...(escalated ? { wait_up_at: now - 10_000, wait_up_count: 5, wait_up_person: "u1", needs_input_notified_key: "5:blocked", hand_wake_notified_key: "5:old" } : {}),
      },
      users: [{ _id: "u1", name: "Me", email: "me@x.ai", notifications_enabled: true, push_token: "tok-u1" }],
      extra: {
        teams: [{ _id: "team1", features: { org: true, session_owners: true } }],
        team_memberships: [{ _id: "tm_u1", user_id: "u1", team_id: "team1", role: "admin", joined_at: 1, visibility: "full" }],
        session_owners: [{ _id: "so1", conversation_id: "conv1", user_id: "u1", added_by: "u1", added_at: 1 }],
        pending_messages: [],
        org_roles: [],
        anchors: [],
        counters: [],
      },
    });
    w.tables.conversations.push({ _id: "lead", short_id: "jxlead1", user_id: "u1", title: "Lead session", status: "active", team_id: "team1", is_private: false, message_count: 30, updated_at: now - 60_000 });
    return w;
  };

  for (const escalated of [false, true]) {
    test(escalated ? "with an escalation stamped to the dragger" : "with no escalation", async () => {
      // The owners write runs on the shared fake db (its org log needs
      // normalizeId); the check then runs on the needs-input world over the
      // same rows.
      const seed = world(escalated).tables;
      const writeDb = makeFakeDb(JSON.parse(JSON.stringify(seed)));
      const scheduled: any[] = [];
      const sched = { runAfter: async (_ms: number, _fn: unknown, args: any) => { scheduled.push(args); } };
      await performApplyOwnersChange({ db: writeDb, scheduler: sched } as any, "u1" as any, { session_id: "conv1", adopt_parent: "lead" });
      const { ctx, tables } = createCtx(JSON.parse(JSON.stringify(writeDb._tables)));

      const x = tables.conversations.find((c) => c._id === "conv1")!;
      expect(x.parent_conversation_id).toBe("lead");
      for (const k of ["wait_up_at", "wait_up_count", "wait_up_person", "hand_wake_notified_key"]) expect(x[k]).toBeUndefined();
      // The episode key stays: people this wait already rang are not rung again.
      expect(x.needs_input_notified_key).toBe(escalated ? "5:blocked" : undefined);
      expect(scheduled.some((a) => a?.conversation_id === "conv1")).toBe(true);

      // The line telling it who it works for leaves its wait standing (it is
      // no answer). While that line waits to be read nobody is rung, and once
      // it is read and the session still waits, its new parent is told.
      expect(x.thread_state_status).toBe("blocked");
      expect(tables.pending_messages.filter((m) => m.conversation_id === "conv1").length).toBe(1);
      const first = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
      expect([first.notified, first.reason]).toEqual([false, "agent_owner"]);
      for (const m of tables.pending_messages) m.status = "delivered";
      x.has_pending_messages = false;
      const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
      expect([res.notified, res.reason]).toEqual([false, "agent_owner"]);
      expect(told(tables, "lead").map((f) => f?.waiting?.short_id)).toEqual(["jx7wait"]);
      expect(tables.notifications.length).toBe(0);

      const db = makeFakeDb(JSON.parse(JSON.stringify(tables)));
      const { sessions } = await computeInboxSessions({ db } as any, "u1" as any, { includeLiveness: false });
      expect(sessions.map((s: any) => s._id)).not.toContain("conv1");
    });
  }

  test("a wait that already rang the dragger is not rung again when its new parent is away", async () => {
    const seed = world(false).tables;
    // The new parent runs on a machine not seen for a day: it cannot answer.
    Object.assign(seed.conversations.find((c) => c._id === "lead")!, { owner_device_id: "dev1" });
    seed.devices = [{ _id: "d1", user_id: "u1", device_id: "dev1", last_seen: now - 86_400_000 }];
    // The wait rings its owner, the dragger, first.
    const pre = createCtx(JSON.parse(JSON.stringify(seed)));
    expect((await performNeedsInputCheck(pre.ctx as any, { conversation_id: "conv1" })).notified).toBe(true);
    expect(pre.tables.notifications.length).toBe(1);

    const writeDb = makeFakeDb(JSON.parse(JSON.stringify(pre.tables)));
    await performApplyOwnersChange({ db: writeDb, scheduler: { runAfter: async () => {} } } as any, "u1" as any, { session_id: "conv1", adopt_parent: "lead" });
    const { ctx, tables } = createCtx(JSON.parse(JSON.stringify(writeDb._tables)));
    for (const m of tables.pending_messages) m.status = "delivered";
    tables.conversations.find((c) => c._id === "conv1")!.has_pending_messages = false;

    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, res.reason]).toEqual([false, "dup"]);
    expect(tables.notifications.length).toBe(1);
    expect(told(tables, "lead")).toEqual([]);
  });
});
