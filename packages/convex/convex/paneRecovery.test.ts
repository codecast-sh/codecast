// A pane that never shows a message (2026-11-11: Union's roles on a laptop at
// load 170-200) must not leave an unattended seat deaf: it restarts once and
// gets the message again; a second refusal inside the window marks the
// session's error and tells the sender the truth, and a delivery clears it.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { enqueuePendingMessage } from "./pendingMessages";
import { allModules } from "./testModules.testkit";
import { PANE_RECOVERY_WINDOW_MS, PANE_REFUSED_ERROR, planPaneRefusal } from "./lib/paneRefusal";

setDefaultTimeout(60_000);

const TOKEN = "pane-recovery-test-token";
const reportPaneRefused = (api as any).paneRecovery.reportPaneRefused;
const updateStatus = (api as any).pendingMessages.updateMessageStatus;

async function setup(opts: { seat: boolean }) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Owner" });
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any);
    const base = { user_id: user, agent_type: "claude_code" as const, started_at: 1, updated_at: 1, message_count: 3, is_private: true, status: "active" as const };
    const sender = await ctx.db.insert("conversations", { ...base, session_id: "sender" });
    const target = await ctx.db.insert("conversations", { ...base, session_id: "seat" });
    if (opts.seat) {
      const anchor = await ctx.db.insert("anchors", { scope_type: "user", scope_user_id: user, bot_user_id: user, host_user_id: user, conversation_id: target, name: "Chestnut", status: "active", created_at: 1 } as any);
      await ctx.db.patch(target, { anchor_id: anchor });
    }
    const conv = await ctx.db.get(target);
    const message = await enqueuePendingMessage(ctx, conv, user, { content: "the day's number", from_conversation_id: sender });
    return { user, sender, target, message };
  });
  return { t, ...ids };
}

const rows = (t: any, conversationId: any) => t.run((ctx: any) => ctx.db.query("pending_messages").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId)).collect());
const commands = (t: any) => t.run((ctx: any) => ctx.db.query("daemon_commands").collect());

describe("planPaneRefusal", () => {
  test("recovers an unattended seat once per window", () => {
    expect(planPaneRefusal({ anchor_id: "a" }, 10)).toEqual({ kind: "recover" });
    expect(planPaneRefusal({ standing_role_id: "r", pane_recovered_at: 10 }, 10 + PANE_RECOVERY_WINDOW_MS - 1)).toEqual({ kind: "give_up", markError: true });
    expect(planPaneRefusal({ standing_role_id: "r", pane_recovered_at: 10 }, 10 + PANE_RECOVERY_WINDOW_MS)).toEqual({ kind: "recover" });
  });
  test("leaves a person's own session and a killed seat alone", () => {
    expect(planPaneRefusal({}, 10)).toEqual({ kind: "give_up", markError: false });
    expect(planPaneRefusal({ anchor_id: "a", inbox_killed_at: 5 }, 10)).toEqual({ kind: "give_up", markError: false });
  });
});

describe("reportPaneRefused", () => {
  test("a seat restarts and gets the message again as a new row", async () => {
    const { t, target, message } = await setup({ seat: true });
    expect(await t.mutation(reportPaneRefused, { message_id: message, api_token: TOKEN })).toEqual({ recovered: true });
    const queued = await rows(t, target);
    expect(queued.find((r: any) => r._id === message)?.status).toBe("cancelled");
    const resent = queued.filter((r: any) => r._id !== message);
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatchObject({ status: "pending", content: "the day's number" });
    expect((await commands(t)).map((c: any) => c.command).sort()).toEqual(["kill_session", "resume_session"]);
  });

  test("a second refusal in the window marks the error, tells the sender, and a delivery clears it", async () => {
    const { t, sender, target, message } = await setup({ seat: true });
    await t.mutation(reportPaneRefused, { message_id: message, api_token: TOKEN });
    const resent = (await rows(t, target)).find((r: any) => r._id !== message)!;
    expect(await t.mutation(reportPaneRefused, { message_id: resent._id, api_token: TOKEN })).toEqual({ recovered: false });
    expect((await commands(t)).filter((c: any) => c.command === "kill_session")).toHaveLength(1);
    const conv = await t.run((ctx: any) => ctx.db.get(target));
    expect(conv.session_error).toBe(PANE_REFUSED_ERROR);
    const receipts = await rows(t, sender);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].content).toContain("never reached it");

    const later = await t.run(async (ctx: any) => enqueuePendingMessage(ctx, await ctx.db.get(target), conv.user_id, { content: "next" }));
    await t.mutation(updateStatus, { message_id: later, status: "delivered", api_token: TOKEN });
    const cleared = await t.run((ctx: any) => ctx.db.get(target));
    expect(cleared.session_error).toBeUndefined();
    expect(cleared.pane_refused_at).toBeUndefined();
  });

  test("a person's own session is not restarted; the sender hears it was dropped", async () => {
    const { t, sender, target, message } = await setup({ seat: false });
    expect(await t.mutation(reportPaneRefused, { message_id: message, api_token: TOKEN })).toEqual({ recovered: false });
    expect(await commands(t)).toHaveLength(0);
    expect((await rows(t, target)).map((r: any) => r.status)).toEqual(["cancelled"]);
    expect((await rows(t, sender))[0].content).toContain("never reached it");
  });
});
