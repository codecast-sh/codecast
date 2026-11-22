// Decision cards ring the phone (lib/decisionPush.ts): one push per card
// group, held while the asking session's turn runs, trimmed at flush to what
// still waits, and the session's own "waiting for you" push stands down while
// a card is open.
import { describe, expect, test } from "bun:test";
import { askCore, withdrawCore } from "./sessionDecisions";
import { BOSS, HOST, askApproach, seed, twoOptions } from "./testDecisions";
import { passCore, unassignCore } from "./decisionHandoff";
import { syncDecisionInbox } from "./lib/decisionInbox";
import { lineNoticesCard } from "./lib/decisionRing";
import { performPushFlush, AWAY_DEBOUNCE_MS } from "./pushRouter";
import { releaseDecisionPushes, DECISION_TURN_HOLD_MS } from "./lib/decisionPush";
import { deliverSessionNotificationToParties } from "./lib/sessionNotify";
import { emitNotification } from "./notificationRouter";

function world(status?: string) {
  const w = seed({
    push_outbox: [],
    push_ring: [],
    notifications: [],
    system_config: [],
    user_presence: [],
    devices: [],
    managed_sessions: status ? [{ _id: "managed_plain", conversation_id: "conversations_plain", session_id: "sess-plain", agent_status: status }] : [],
  });
  Object.assign(w.tables.users.find((u: any) => u._id === HOST), { push_token: "ExponentPushToken[x]", notifications_enabled: true });
  w.tables.conversations.find((c: any) => c._id === "conversations_plain").title = "Billing fix";
  return w;
}

const ask = (ctx: any, question: string, extra: Record<string, unknown> = {}) =>
  askCore(ctx, { userId: HOST }, { session_id: "sess-plain", question, options: twoOptions, context_md: "Why.", category: "approach", ...extra });

const hostOutbox = (tables: any) => tables.push_outbox.filter((r: any) => r.user_id === HOST);

describe("a card waiting on you rings your phone", () => {
  test("one card from your own session: the session asks the question, the tap opens the card", async () => {
    const { ctx, tables } = world();
    const r = await ask(ctx, "Ship the billing fix now?");
    expect(r.error).toBeUndefined();
    const [row] = hostOutbox(tables);
    expect(row).toMatchObject({ type: "decision_waiting", title: "Billing fix", body: "Ship the billing fix now?" });
    expect(row.data).toMatchObject({ link: `/decisions/${r.short_id}`, decision_ids: [String(r.id)] });
    expect(row.due_at - Date.now()).toBeLessThanOrEqual(AWAY_DEBOUNCE_MS);
    expect(tables.notifications.filter((n: any) => n.type === "decision_waiting")).toHaveLength(1);
  });

  test("the cards one turn asks are one push, held until the turn ends", async () => {
    const { ctx, tables, scheduled } = world("working");
    await ask(ctx, "Ship the billing fix now?");
    await ask(ctx, "Refund the two affected customers?");
    await ask(ctx, "Email the team about it?");
    const rows = hostOutbox(tables);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Billing fix: 3 decisions");
    expect(rows[0].body).toBe("1. Ship the billing fix now?\n2. Refund the two affected customers?\n3. Email the team about it?");
    expect(rows[0].data.link).toBe("/decisions");
    expect(rows[0].due_at - Date.now()).toBeGreaterThan(DECISION_TURN_HOLD_MS - 5_000);
    expect(tables.notifications.filter((n: any) => n.type === "decision_waiting")).toHaveLength(1);

    const now = Date.now();
    await releaseDecisionPushes(ctx, "conversations_plain" as any, now);
    expect(hostOutbox(tables)[0].due_at).toBe(now + AWAY_DEBOUNCE_MS);
    expect(scheduled.at(-1)?.args).toEqual({ user_id: HOST });
  });

  test("an advisory card does not ring: its session goes ahead on the default", async () => {
    const { ctx, tables } = world();
    await ask(ctx, "Back off or switch keys?", { blocking: false, default_option: 0 });
    expect(hostOutbox(tables)).toHaveLength(0);
  });

  test("cards answered or withdrawn before the flush drop out of the push, and none left sends nothing", async () => {
    const { ctx, tables } = world("working");
    const a = await ask(ctx, "Ship the billing fix now?");
    await ask(ctx, "Refund the two affected customers?");
    await withdrawCore(ctx, tables.session_decisions.find((d: any) => d._id === a.id), Date.now());
    hostOutbox(tables)[0].due_at = Date.now();
    await performPushFlush(ctx, HOST);
    expect(tables.push_ring).toHaveLength(1);
    expect(tables.push_ring[0]).toMatchObject({ type: "decision_waiting", title: "Billing fix", body: "Refund the two affected customers?" });

    const { ctx: ctx2, tables: t2 } = world();
    const b = await ask(ctx2, "Ship the billing fix now?");
    await withdrawCore(ctx2, t2.session_decisions.find((d: any) => d._id === b.id), Date.now());
    hostOutbox(t2)[0].due_at = Date.now();
    await performPushFlush(ctx2, HOST);
    expect(t2.push_ring).toHaveLength(0);
    expect(hostOutbox(t2)).toHaveLength(0);
  });

  test("muting mentions mutes card pushes, like every other decision notice", async () => {
    const { ctx, tables } = world();
    tables.users.find((u: any) => u._id === HOST).notification_preferences = { mention: false };
    await ask(ctx, "Ship the billing fix now?");
    expect(hostOutbox(tables)).toHaveLength(0);
  });
});

describe("a session parked on a card does not also ring as waiting", () => {
  test("session_idle stands down while a blocking card is open, and rings once it is not", async () => {
    const { ctx, tables } = world();
    const conv = tables.conversations.find((c: any) => c._id === "conversations_plain");
    const r = await ask(ctx, "Ship the billing fix now?");
    expect(await deliverSessionNotificationToParties(ctx, conv, "session_idle", "Billing fix", "Done")).toBe(false);
    // Errors are different news and still ring.
    expect(await deliverSessionNotificationToParties(ctx, conv, "session_error", "Billing fix", "Signed out")).toBe(true);
    await withdrawCore(ctx, tables.session_decisions.find((d: any) => d._id === r.id), Date.now());
    expect(await deliverSessionNotificationToParties(ctx, conv, "session_idle", "Billing fix", "Done")).toBe(true);
  });

  test("a person the card did not ring still hears the session wait", async () => {
    const { ctx, tables } = world();
    const conv = tables.conversations.find((c: any) => c._id === "conversations_plain");
    tables.users.find((u: any) => u._id === HOST).notification_preferences = { mention: false };
    await ask(ctx, "Ship the billing fix now?");
    expect(await deliverSessionNotificationToParties(ctx, conv, "session_idle", "Billing fix", "Done")).toBe(true);

    // Not in their queue (a role holds it, or it went to someone else): same.
    const w = world();
    const conv2 = w.tables.conversations.find((c: any) => c._id === "conversations_plain");
    await ask(w.ctx, "Ship the billing fix now?");
    w.tables.decision_inbox.splice(0, w.tables.decision_inbox.length);
    expect(await deliverSessionNotificationToParties(w.ctx, conv2, "session_idle", "Billing fix", "Done")).toBe(true);
  });
});

describe("the bell stops claiming a card waits once it does not", () => {
  const unreadCardNotes = (tables: any) => tables.notifications.filter((n: any) => n.type === "decision_waiting" && !n.read);

  test("withdrawing every card of the group marks it read; one of two still waiting keeps it unread", async () => {
    const { ctx, tables } = world("working");
    const a = await ask(ctx, "Ship the billing fix now?");
    const b = await ask(ctx, "Refund the two affected customers?");
    await withdrawCore(ctx, tables.session_decisions.find((d: any) => d._id === a.id), Date.now());
    expect(unreadCardNotes(tables)).toHaveLength(1);
    await withdrawCore(ctx, tables.session_decisions.find((d: any) => d._id === b.id), Date.now());
    expect(unreadCardNotes(tables)).toHaveLength(0);
  });

  test("a card handed to someone else stops waiting on the person it left", async () => {
    const { ctx, tables } = world();
    const r = await ask(ctx, "Ship the billing fix now?");
    await syncDecisionInbox(ctx, r.id, [BOSS], Date.now(), true, { announce: false });
    expect(unreadCardNotes(tables).filter((n: any) => n.recipient_user_id === HOST)).toHaveLength(0);
  });

  test("a staged push trimmed to nothing settles its bell entry too", async () => {
    const { ctx, tables } = world();
    await ask(ctx, "Ship the billing fix now?");
    tables.decision_inbox.find((r: any) => r.user_id === HOST).status = "done";
    hostOutbox(tables)[0].due_at = Date.now();
    await performPushFlush(ctx, HOST);
    expect(tables.push_ring).toHaveLength(0);
    expect(unreadCardNotes(tables)).toHaveLength(0);
  });
});

describe("acts a person takes on a card do not ring their own phone", () => {
  test("taking back a card you passed rings nobody", async () => {
    const { ctx, tables } = world();
    await askApproach(ctx);
    expect(await passCore(ctx, HOST, "sd-1", { kind: "user", id: BOSS })).toEqual({ passed: true });
    tables.push_outbox.splice(0, tables.push_outbox.length);
    expect(await unassignCore(ctx, HOST, "sd-1")).toEqual({ unassigned: true });
    expect(tables.decision_inbox.some((r: any) => r.user_id === HOST && r.status === "pending")).toBe(true);
    expect(hostOutbox(tables)).toHaveLength(0);
  });
});

describe("the desk hold keeps a turn's cards together", () => {
  test("holding another push while you are at your desk never pulls a turn-held card push forward", async () => {
    const { ctx, tables } = world("working");
    await ask(ctx, "Ship the billing fix now?");
    const card = hostOutbox(tables)[0];
    const heldUntil = card.due_at;
    const now = Date.now();
    tables.user_presence.push({ _id: "user_presence_1", user_id: HOST, surface: "desktop", last_seen: now, last_input_at: now, focused: true, updated_at: now });
    tables.push_outbox.push({ _id: "push_outbox_other", user_id: HOST, type: "chat_dm", title: "Ashot", body: "hey", created_at: now, due_at: now, deferred: false });
    await performPushFlush(ctx, HOST);
    expect(tables.push_outbox.find((r: any) => r._id === "push_outbox_other").due_at).toBeLessThan(heldUntil);
    expect(card.due_at).toBe(heldUntil);
  });
});

describe("a change card rings once, through the line's own notice", () => {
  test("a run's card held by a person is the line's card_waiting, never a second decision push", async () => {
    const { ctx, tables } = world();
    const id = await ctx.db.insert("session_decisions", {
      conversation_id: "conversations_plain", session_id: "sess-plain", user_id: HOST, short_id: "sd-9", question: "Ship this change?",
      options: twoOptions, blocking: true, status: "pending", workflow_run_id: "workflow_runs_1", gate_node_id: "decide", task_id: "tasks_t1",
      holder: { kind: "user", id: HOST }, asked_user_ids: [HOST], created_at: Date.now(),
    });
    await syncDecisionInbox(ctx, id, [HOST], Date.now());
    expect(hostOutbox(tables)).toHaveLength(0);
    expect(tables.notifications.filter((n: any) => n.type === "decision_waiting")).toHaveLength(0);
    expect(lineNoticesCard({ workflow_run_id: "w", task_id: "t", gate_node_id: "decide", holder: { kind: "role" } })).toBe(false);
  });
});

describe("machine alerts have their own switch", () => {
  test("machine_alerts off mutes an overloaded machine without muting session errors", async () => {
    const { ctx, tables } = world();
    tables.users.find((u: any) => u._id === HOST).notification_preferences = { machine_alerts: false, session_error: true };
    const overload = await emitNotification(ctx, { event_type: "machine_overloaded", entity_type: "machine", entity_id: "dev1", direct_recipient_id: HOST, actor_name: "jb-m5-max", message: "CPU 99%" } as any);
    expect(overload.notified).toBe(0);
    const conv = tables.conversations.find((c: any) => c._id === "conversations_plain");
    expect(await deliverSessionNotificationToParties(ctx, conv, "session_error", "Billing fix", "Signed out")).toBe(true);
  });
});
