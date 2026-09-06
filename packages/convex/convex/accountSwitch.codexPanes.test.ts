// The server half of the Codex account registry (ct-49528): the daemon records
// which account each pane launched on, and the backend names the panes the
// machine's current login left behind.
import { describe, expect, test } from "bun:test";
import { listStaleCodexSessions, recordCodexAccount } from "./accountSwitch";
import { makeFakeDb } from "./testDb";

const NOW = Date.now();

function fixture() {
  const device = {
    _id: "devices_mac",
    user_id: "users_owner",
    device_id: "mac",
    last_seen: NOW,
    codex_accounts: {
      active_email: "a@x.com",
      profiles: [
        { name: "ashot", email: "a@x.com" },
        { name: "footage", email: "f@x.com" },
      ],
    },
  };
  const tables: Record<string, any[]> = { devices: [device], conversations: [], managed_sessions: [] };
  const db = makeFakeDb(tables);
  const ctx = {
    db,
    auth: { async getUserIdentity() { return { subject: "users_owner|session" }; } },
  };

  const session = (id: string, conversationId: string) =>
    tables.managed_sessions.push({
      _id: `managed_${id}`,
      session_id: id,
      conversation_id: conversationId,
      user_id: "users_owner",
      pid: 1,
      started_at: NOW,
      last_heartbeat: NOW,
    });
  const conversation = (id: string, extra: Record<string, any> = {}) =>
    tables.conversations.push({
      _id: id,
      user_id: "users_owner",
      session_id: `session-${id}`,
      agent_type: "codex",
      owner_device_id: "mac",
      title: `title ${id}`,
      ...extra,
    });

  return { tables, db, ctx, device, session, conversation };
}

const listStale = (ctx: any) => (listStaleCodexSessions as any)._handler(ctx, {});
const record = (ctx: any, args: any) => (recordCodexAccount as any)._handler(ctx, args);

describe("recordCodexAccount", () => {
  test("stamps the account the launching daemon reported", async () => {
    const f = fixture();
    f.conversation("conversations_a");
    expect(await record(f.ctx, { conversation_id: "conversations_a", codex_account: "ashot" })).toEqual({
      codex_account: "ashot",
    });
    expect(f.tables.conversations[0].codex_account).toBe("ashot");
  });

  test("clears the record when the daemon could not name the account", async () => {
    const f = fixture();
    f.conversation("conversations_a", { codex_account: "ashot" });
    expect(await record(f.ctx, { conversation_id: "conversations_a" })).toEqual({ codex_account: null });
    expect(f.tables.conversations[0].codex_account).toBeUndefined();
  });

  test("writes nothing when the row already says so", async () => {
    const f = fixture();
    f.conversation("conversations_a", { codex_account: "ashot" });
    await record(f.ctx, { conversation_id: "conversations_a", codex_account: "ashot" });
    expect((f.db as any)._patched).toEqual([]);
  });

  test("refuses a conversation that is not the caller's", async () => {
    const f = fixture();
    f.conversation("conversations_a", { user_id: "users_someone_else" });
    expect(await record(f.ctx, { conversation_id: "conversations_a", codex_account: "ashot" })).toBeNull();
    expect(f.tables.conversations[0].codex_account).toBeUndefined();
  });
});

describe("listStaleCodexSessions", () => {
  test("names the live panes still running a previous account", async () => {
    const f = fixture();
    f.conversation("conversations_old", { codex_account: "footage" });
    f.session("s-old", "conversations_old");
    f.conversation("conversations_current", { codex_account: "ashot" });
    f.session("s-current", "conversations_current");

    expect(await listStale(f.ctx)).toEqual([
      {
        conversation_id: "conversations_old",
        session_id: "s-old",
        title: "title conversations_old",
        device_id: "mac",
        codex_account: "footage",
        active_account: "ashot",
      },
    ]);
  });

  test("leaves an unattributed pane alone — a restart must be justified", async () => {
    const f = fixture();
    f.conversation("conversations_blank");
    f.session("s-blank", "conversations_blank");
    expect(await listStale(f.ctx)).toEqual([]);
  });

  test("names nothing when the device's own login cannot be resolved", async () => {
    const f = fixture();
    // A machine whose active login was never enrolled: every pane would look
    // stale, and every restart would be a guess.
    f.device.codex_accounts.active_email = "nobody@x.com";
    f.conversation("conversations_old", { codex_account: "footage" });
    f.session("s-old", "conversations_old");
    expect(await listStale(f.ctx)).toEqual([]);
  });

  test("judges each pane against the device that actually runs it", async () => {
    const f = fixture();
    f.tables.devices.push({
      _id: "devices_second",
      user_id: "users_owner",
      device_id: "laptop",
      last_seen: NOW,
      codex_accounts: { active_email: "f@x.com", profiles: [{ name: "footage", email: "f@x.com" }] },
    });
    // Same account name, opposite verdicts: current on the laptop, stale on the mac.
    f.conversation("conversations_laptop", { codex_account: "footage", owner_device_id: "laptop" });
    f.session("s-laptop", "conversations_laptop");
    f.conversation("conversations_mac", { codex_account: "footage" });
    f.session("s-mac", "conversations_mac");
    expect((await listStale(f.ctx)).map((r: any) => r.conversation_id)).toEqual(["conversations_mac"]);
  });

  test("reports one row per conversation even when two panes claim it", async () => {
    const f = fixture();
    f.conversation("conversations_old", { codex_account: "footage" });
    f.session("s-one", "conversations_old");
    f.session("s-two", "conversations_old");
    expect(await listStale(f.ctx)).toHaveLength(1);
  });

  test("answers an unauthenticated caller with nothing at all", async () => {
    const f = fixture();
    f.conversation("conversations_old", { codex_account: "footage" });
    f.session("s-old", "conversations_old");
    const anon = { db: f.db, auth: { async getUserIdentity() { return null; } } };
    expect(await listStale(anon)).toEqual([]);
  });
});
