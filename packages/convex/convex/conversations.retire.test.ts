import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

// A flow run's subject at the run's end (flows.md FL4): the run reads the
// session even when it is killed, and retires it only when the kill would cut
// nothing off.

const TOKEN = "retire-test-token";

async function setup(subject: Record<string, unknown> = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.db.insert("users", { emailVerificationTime: 1, name: "Riley" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", started_at: now, updated_at: now, status: "active", short_id: "jx7subj", session_id: "s-subj", title: "Make a.txt good", message_count: 12, ...subject,
    } as any);
    return { user, conv };
  });
  const retire = (expected = 12) => t.mutation(api.conversations.cliRetireSession, { session: "jx7subj", expected_message_count: expected, api_token: TOKEN });
  const row = () => t.run(async (ctx) => (await ctx.db.get(ids.conv)) as any);
  const live = (conversation: any, agent_status: string) => t.run(async (ctx) => {
    await ctx.db.insert("managed_sessions", { session_id: `s-${String(conversation).slice(-4)}`, conversation_id: conversation, user_id: ids.user, pid: 1, started_at: Date.now() - 60_000, last_heartbeat: Date.now(), agent_status, agent_status_updated_at: Date.now() } as any);
  });
  return { t, ids, retire, row, live };
}

describe("the run reads its subject even when it is killed", () => {
  test("a killed session named with include_killed is listed, killed; without it the row is not there", async () => {
    const { t } = await setup({ inbox_killed_at: Date.now() - 1000, inbox_dismissed_at: Date.now() - 1000, status: "completed" });
    const read = (include_killed?: boolean) => t.query(api.conversations.inboxForCLI, { api_token: TOKEN, session_ids: ["jx7subj"], show_all: true, ...(include_killed ? { include_killed } : {}) }) as Promise<any>;
    expect((await read()).sessions).toEqual([]);
    const [row] = (await read(true)).sessions;
    expect(row.is_killed).toBe(true);
    expect(row.message_count).toBe(12);
    expect(typeof row.work_state).toBe("string");
  });
});

describe("cliRetireSession", () => {
  test("a settled session with nothing in flight is killed", async () => {
    const { retire, row, live, ids } = await setup();
    await live(ids.conv, "idle");
    expect(await retire()).toMatchObject({ retired: true, short_id: "jx7subj" });
    const conv = await row();
    expect(conv.inbox_killed_at).toBeGreaterThan(0);
    expect(conv.inbox_dismissed_at).toBeGreaterThan(0);
  });

  const refuses = async (s: Awaited<ReturnType<typeof setup>>, reason: RegExp, expected = 12) => {
    const r = (await s.retire(expected)) as any;
    expect(r.retired).toBe(false);
    expect(r.reason).toMatch(reason);
    expect((await s.row()).inbox_killed_at).toBeUndefined();
  };

  test("refuses when the transcript moved since the run read it", async () => {
    await refuses(await setup(), /moved since the run read it \(11 messages then, 12 now\)/, 11);
  });

  test("refuses a session a person pinned", async () => {
    await refuses(await setup({ inbox_pinned_at: Date.now() - 1000 }), /a person pinned it/);
  });

  test("refuses while a message is queued for it", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("pending_messages", { conversation_id: s.ids.conv, from_user_id: s.ids.user, content: "one more thing", status: "pending", created_at: Date.now(), retry_count: 0 } as any);
    });
    await refuses(s, /a message is queued/);
  });

  test("refuses while a trigger is armed on it", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("agent_tasks", { user_id: s.ids.user, title: "check CI", prompt: "check CI", schedule_type: "once", mode: "apply", status: "scheduled", retry_count: 0, run_count: 0, created_at: Date.now(), originating_conversation_id: s.ids.conv } as any);
    });
    await refuses(s, /a trigger is armed/);
  });

  test("refuses while it is working or waiting on background work", async () => {
    const working = await setup();
    await working.live(working.ids.conv, "working");
    await refuses(working, /it is working/);
    const waiting = await setup();
    await waiting.live(waiting.ids.conv, "waiting");
    await refuses(waiting, /it is working/);
  });

  test("refuses while a nested session of its own is live", async () => {
    const s = await setup();
    const child = await s.t.run(async (ctx) => ctx.db.insert("conversations", {
      user_id: s.ids.user, agent_type: "claude_code", started_at: Date.now(), status: "active", short_id: "jx7chld", is_subagent: true, parent_conversation_id: s.ids.conv,
    } as any));
    await s.live(child, "working");
    await refuses(s, /nested session jx7chld is live/);
  });

  test("refuses while a nested session that is not live has a message queued or a trigger armed: the kill would drop them", async () => {
    const child = async (s: Awaited<ReturnType<typeof setup>>, shortId: string) => s.t.run(async (ctx) => ctx.db.insert("conversations", {
      user_id: s.ids.user, agent_type: "claude_code", started_at: Date.now(), status: "active", short_id: shortId, is_subagent: true, parent_conversation_id: s.ids.conv,
    } as any));
    const queued = await setup();
    const q = await child(queued, "jx7chlq");
    await queued.t.run(async (ctx) => {
      await ctx.db.insert("pending_messages", { conversation_id: q, from_user_id: queued.ids.user, content: "later", status: "pending", created_at: Date.now(), retry_count: 0 } as any);
    });
    await refuses(queued, /a message is queued for its nested session jx7chlq/);
    const armed = await setup();
    const a = await child(armed, "jx7chla");
    await armed.t.run(async (ctx) => {
      await ctx.db.insert("agent_tasks", { user_id: armed.ids.user, title: "check", prompt: "check", schedule_type: "once", mode: "apply", status: "scheduled", retry_count: 0, run_count: 0, created_at: Date.now(), originating_conversation_id: a } as any);
    });
    await refuses(armed, /a trigger is armed for its nested session jx7chla/);
  });

  test("refuses a session already stopped", async () => {
    const s = await setup({ inbox_killed_at: 5 });
    const r = (await s.retire()) as any;
    expect(r).toMatchObject({ retired: false, reason: "it is already stopped" });
    expect((await s.row()).inbox_killed_at).toBe(5);
  });
});
