// The folder-transfer progress row: only the owner's running machine reports
// it, strings stay bounded, done clears it, and Cancel round-trips to the
// daemon's next report.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { presentToken } from "@platform/auth/convex";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { PEER_TRANSFER_TEXT_MAX } from "./peerTransfers";

setDefaultTimeout(120_000);

const SECRET = "peer-transfer-secret";
const OTHER_SECRET = "peer-transfer-other";

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
    const other = await ctx.db.insert("users", { name: "Bo", email: "bo@x.dev" } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(SECRET), name: "mac", created_at: 1, last_used_at: 1, device_id: "here" } as any);
    await ctx.db.insert("api_tokens", { user_id: other, token_hash: await hashToken(OTHER_SECRET), name: "bo", created_at: 1, last_used_at: 1, device_id: "bos-mac" } as any);
    for (const [user, device_id] of [[owner, "here"], [owner, "there"], [other, "bos-mac"]] as const) {
      await ctx.db.insert("devices", { user_id: user, device_id, label: device_id, platform: "darwin", last_seen: Date.now() } as any);
    }
    const conv = await ctx.db.insert("conversations", {
      user_id: owner, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1,
      message_count: 0, is_private: true, status: "active", owner_device_id: "here", project_path: "/Users/ann/src/family",
    } as any);
    return { owner, other, conv };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  const token = presentToken(SECRET, "here");
  const row = () => t.run(async (ctx) => (await ctx.db.get(ids.conv))?.peer_transfer ?? null);
  const report = (patch: Record<string, unknown>, opts: { token?: string; device_id?: string } = {}) =>
    t.mutation(api.peerTransfers.reportPeerTransfer, {
      api_token: opts.token ?? token, device_id: opts.device_id ?? "here", conversation_id: ids.conv, started_at: 1000, phase: "asking", ...patch,
    } as any);
  return { t, ...ids, as, token, row, report };
}

describe("reportPeerTransfer", () => {
  test("the owner's running machine writes each phase; done clears the row", async () => {
    const { row, report } = await setup();
    expect(await report({})).toEqual({ cancel: false });
    expect(await row()).toMatchObject({ phase: "asking", started_at: 1000 });
    await report({ phase: "receiving", from: "MacBook-Pro-182", mode: "direct", bytes: 10.6, total: 100 });
    expect(await row()).toMatchObject({ phase: "receiving", from: "MacBook-Pro-182", mode: "direct", bytes: 11, total: 100 });
    await report({ phase: "done" });
    expect(await row()).toBeNull();
  });

  test("another machine of the owner, another user, or an unknown device is refused", async () => {
    const { conv, other, t, row, report } = await setup();
    await expect(report({}, { device_id: "there" })).rejects.toThrow(/another machine runs/);
    await expect(report({}, { device_id: "nope" })).rejects.toThrow(/Unknown device/);
    await expect(report({}, { token: presentToken(OTHER_SECRET, "bos-mac"), device_id: "bos-mac" })).rejects.toThrow(/not your conversation/);
    await expect(t.mutation(api.peerTransfers.reportPeerTransfer, { device_id: "here", conversation_id: conv, started_at: 1, phase: "asking" })).rejects.toThrow(/Authentication/);
    expect(await row()).toBeNull();
    void other;
  });

  test("strings are bounded and negative counts dropped", async () => {
    const { row, report } = await setup();
    await report({ phase: "failed", reason: "x".repeat(5000), from: "y".repeat(5000), bytes: -5 });
    const r = await row();
    expect(r?.reason?.length).toBe(PEER_TRANSFER_TEXT_MAX);
    expect(r?.from?.length).toBe(PEER_TRANSFER_TEXT_MAX);
    expect(r?.bytes).toBeUndefined();
  });
});

describe("cancelPeerTransfer", () => {
  test("a cancel reaches the daemon's next report of the same transfer, never a newer one", async () => {
    const { as, owner, conv, row, report } = await setup();
    await report({ phase: "receiving", bytes: 1, total: 10 });
    await as(owner).mutation(api.peerTransfers.cancelPeerTransfer, { conversation_id: conv });
    expect((await row())?.cancel_requested_at).toBeGreaterThanOrEqual(1000);
    expect(await report({ phase: "receiving", bytes: 2, total: 10 })).toEqual({ cancel: true });
    expect(await report({ phase: "failed", reason: "cancelled" })).toEqual({ cancel: true });
    expect(await report({ started_at: 2000 })).toEqual({ cancel: false });
    expect((await row())?.cancel_requested_at).toBeUndefined();
  });

  test("only the conversation's owner may cancel", async () => {
    const { as, other, conv, row, report } = await setup();
    await report({});
    await expect(as(other).mutation(api.peerTransfers.cancelPeerTransfer, { conversation_id: conv })).rejects.toThrow(/not your conversation/);
    expect((await row())?.cancel_requested_at).toBeUndefined();
  });
});

describe("dismissPeerTransfer", () => {
  test("clears the transfer the owner saw, never a newer one or someone else's", async () => {
    const { as, owner, other, conv, row, report } = await setup();
    await report({ phase: "failed", reason: "none of your other machines has it" });
    await expect(as(other).mutation(api.peerTransfers.dismissPeerTransfer, { conversation_id: conv, started_at: 1000 })).rejects.toThrow(/not your conversation/);
    await report({ started_at: 2000 });
    await as(owner).mutation(api.peerTransfers.dismissPeerTransfer, { conversation_id: conv, started_at: 1000 });
    expect(await row()).toMatchObject({ phase: "asking", started_at: 2000 });
    await as(owner).mutation(api.peerTransfers.dismissPeerTransfer, { conversation_id: conv, started_at: 2000 });
    expect(await row()).toBeNull();
  });
});

describe("getConversationWithMeta", () => {
  test("sends a finished transfer as null, so a merging client drops the row", async () => {
    const { as, owner, conv, report } = await setup();
    const meta = () => as(owner).query(api.conversations.getConversationWithMeta, { conversation_id: conv, strip_volatile: true });
    await report({ phase: "receiving", bytes: 1, total: 10 });
    expect((await meta())?.peer_transfer).toMatchObject({ phase: "receiving" });
    await report({ phase: "done" });
    const done = await meta();
    expect(done).toHaveProperty("peer_transfer", null);
  });
});
