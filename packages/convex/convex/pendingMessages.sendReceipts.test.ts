import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { sendArrival, sessionMessageIntentOf } from "@codecast/shared/contracts";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./pendingMessages.ts": () => import("./pendingMessages"),
  "./messages.ts": () => import("./messages"),
  "./conversations.ts": () => import("./conversations"),
  "./dispatch.ts": () => import("./dispatch"),
};

const TOKEN = "send-receipts-test-token";

type Target = {
  agent_type?: string;
  session?: { agent_status: string; tmux_session?: string; backend?: "sdk"; status_age_ms?: number } | null;
  deviceOnline?: boolean;
  killed?: boolean;
};

async function setup(target: Target) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.db.insert("users", { emailVerificationTime: 1, name: "Riley" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    await ctx.db.insert("devices", { user_id: user, device_id: "mac", label: "Mac", platform: "darwin", last_seen: target.deviceOnline === false ? now - 24 * 3600_000 : now } as any);
    const sender = await ctx.db.insert("conversations", { user_id: user, agent_type: "claude_code", started_at: now, short_id: "jx7send", owner_device_id: "mac" } as any);
    const recipient = await ctx.db.insert("conversations", {
      user_id: user,
      agent_type: target.agent_type ?? "claude_code",
      started_at: now,
      short_id: "jx7recv",
      owner_device_id: "mac",
      ...(target.killed ? { inbox_killed_at: now - 1000 } : {}),
    } as any);
    if (target.session) {
      await ctx.db.insert("managed_sessions", {
        session_id: "s-recv",
        conversation_id: recipient,
        user_id: user,
        pid: 1234,
        started_at: now - 60_000,
        last_heartbeat: now,
        agent_status: target.session.agent_status,
        agent_status_updated_at: now - (target.session.status_age_ms ?? 1000),
        ...(target.session.tmux_session ? { tmux_session: target.session.tmux_session } : {}),
        ...(target.session.backend ? { backend: target.session.backend } : {}),
      } as any);
    }
    return { user, sender, recipient };
  });
  const send = (extra: Record<string, unknown> = {}) =>
    t.mutation(api.pendingMessages.sendSessionMessage, { to: "jx7recv", from: "jx7send", body: "the auth half is merged", api_token: TOKEN, ...extra } as any);
  const status = () => t.query(api.pendingMessages.sendStatus, { to: "jx7recv", from: "jx7send", api_token: TOKEN });
  return { t, ids, send, status };
}

describe("cast send says when the message arrives", () => {
  test("an idle live session takes it now", async () => {
    const { send } = await setup({ session: { agent_status: "idle", tmux_session: "cc-recv" } });
    expect((await send()).arrives).toBe("now");
  });

  test("a busy Claude session in a pane takes it at its next tool call", async () => {
    const { send } = await setup({ session: { agent_status: "working", tmux_session: "cc-recv" } });
    const result = await send();
    expect(result.arrives).toBe("next_tool_call");
    expect(result.target_live).toBe(true);
  });

  test("a busy Claude session under the SDK host takes it at its next tool call", async () => {
    const { send } = await setup({ session: { agent_status: "working", backend: "sdk" } });
    expect((await send()).arrives).toBe("next_tool_call");
  });

  test("a busy Claude session with no pane and no SDK host waits for the end of its turn", async () => {
    const { send } = await setup({ session: { agent_status: "working" } });
    expect((await send()).arrives).toBe("end_of_turn");
  });

  test("a busy Codex session waits for the end of its turn", async () => {
    const { send } = await setup({ agent_type: "codex", session: { agent_status: "working", tmux_session: "cc-recv" } });
    expect((await send()).arrives).toBe("end_of_turn");
  });

  test("no live process on an online machine: resumed to deliver", async () => {
    const { send } = await setup({ session: null });
    const result = await send();
    expect(result.arrives).toBe("on_resume");
    expect(result.target_live).toBe(true);
  });

  test("an offline machine: when it comes back", async () => {
    const { send } = await setup({ session: null, deviceOnline: false });
    const result = await send();
    expect(result.arrives).toBe("when_online");
    expect(result.target_live).toBe(false);
  });

  test("a permission prompt holds it until someone answers", async () => {
    const { send } = await setup({ session: { agent_status: "permission_blocked", tmux_session: "cc-recv" } });
    expect((await send()).arrives).toBe("after_prompt");
  });

  test("a process still starting takes it once started", async () => {
    const { send } = await setup({ session: { agent_status: "starting", tmux_session: "cc-recv" } });
    expect((await send()).arrives).toBe("after_start");
  });

  test("a stopped process with a live heartbeat is resumed to deliver", async () => {
    const { send } = await setup({ session: { agent_status: "stopped", tmux_session: "cc-recv" } });
    expect((await send()).arrives).toBe("on_resume");
  });

  test("a workflow run's log says it never arrives", async () => {
    const { t, ids, send } = await setup({ session: null });
    await t.run((ctx) => ctx.db.patch(ids.recipient, { is_workflow_primary: true, session_id: "wf-run1" } as any));
    expect((await send()).arrives).toBe("never");
  });

  test("a stale working status left by a lost hook reads as settled", async () => {
    const { send } = await setup({ session: { agent_status: "working", tmux_session: "cc-recv", status_age_ms: 6 * 3600_000 } });
    expect((await send()).arrives).toBe("now");
  });

  test("a killed session is refused unless woken", async () => {
    const { send } = await setup({ session: null, killed: true });
    await expect(send({ wake: false })).rejects.toThrow(/^Not sent\./);
    expect((await send({ wake: true })).arrives).toBe("on_resume");
  });
});

describe("a message says whether a reply is wanted", () => {
  test("--done and --fyi ride the wrapper; a request writes nothing", async () => {
    const { t, send } = await setup({ session: { agent_status: "idle", tmux_session: "cc-recv" } });
    await send();
    await send({ intent: "inform", body: "main is red, not yours" });
    await send({ intent: "done", body: "nothing left for you" });
    const rows = await t.run((ctx) => ctx.db.query("pending_messages").collect());
    const contents = rows.map((r: any) => r.content);
    expect(contents[0]).toStartWith('<session-message from="jx7send">\n');
    expect(contents[1]).toStartWith('<session-message from="jx7send" intent="inform">\n');
    expect(contents[2]).toStartWith('<session-message from="jx7send" intent="done">\n');
    expect(contents.map(sessionMessageIntentOf)).toEqual(["request", "inform", "done"]);
  });

  test("an intent on a raw send is refused", async () => {
    const { send } = await setup({ session: { agent_status: "idle", tmux_session: "cc-recv" } });
    await expect(send({ raw: true, body: "/model opus", intent: "done" })).rejects.toThrow(/--done and --fyi/);
  });
});

describe("cast send --status", () => {
  test("lists this session's sends newest first, with typed-in and delivered times", async () => {
    const { t, send, status } = await setup({ session: { agent_status: "idle", tmux_session: "cc-recv" } });
    const first = await send({ body: "first" });
    const second = await send({ body: "second\nline mentions </session-message> too", intent: "done" });
    const at = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(first.message_id, { status: "delivered", paste_verified_at: at - 300, delivered_at: at - 100 } as any);
      await ctx.db.patch(second.message_id, { status: "injected", delivered_at: at - 50 } as any);
    });
    const result = await status();
    expect(result.to_short_id).toBe("jx7recv");
    expect(result.sends.map((s) => s.preview)).toEqual(["second line mentions </session-message> too", "first"]);
    expect(result.sends[0]).toMatchObject({ status: "injected", intent: "done" });
    expect(result.sends[0].delivered_at).toBeUndefined();
    expect(result.sends[1]).toMatchObject({ status: "delivered", typed_in_at: at - 300, delivered_at: at - 100, intent: "request" });
  });

  test("a fenced delivery abandoned as ambiguous reads unconfirmed, and a waiting row says why", async () => {
    const { t, send, status } = await setup({ session: { agent_status: "idle", tmux_session: "cc-recv" } });
    const first = await send({ body: "first" });
    const second = await send({ body: "second" });
    await t.run(async (ctx) => {
      await ctx.db.patch(first.message_id, { status: "cancelled", delivery_status: "abandoned-ambiguous" } as any);
      await ctx.db.patch(second.message_id, { delivery_disposition_reason: "terminal waiting for a human answer" } as any);
    });
    const [newest, oldest] = (await status()).sends;
    expect(newest).toMatchObject({ status: "pending", reason: "terminal waiting for a human answer" });
    expect(oldest.status).toBe("unconfirmed");
  });

  test("a typed-in send with no echo reads unconfirmed before and after its expiry", async () => {
    const { t, send, status } = await setup({ session: { agent_status: "idle", tmux_session: "cc-recv" } });
    const failed = await send({ body: "failed unconfirmed" });
    const expired = await send({ body: "expired" });
    const withdrawn = await send({ body: "withdrawn" });
    await t.run(async (ctx) => {
      await ctx.db.patch(failed.message_id, { status: "failed", delivery_disposition_reason: "unconfirmed", paste_verified_at: Date.now() } as any);
      await ctx.db.patch(expired.message_id, { status: "cancelled", paste_verified_at: Date.now() } as any);
      await ctx.db.patch(withdrawn.message_id, { status: "cancelled" } as any);
    });
    const byPreview = Object.fromEntries((await status()).sends.map((s) => [s.preview, s]));
    expect(byPreview["failed unconfirmed"].status).toBe("unconfirmed");
    expect(byPreview["failed unconfirmed"].reason).toBeUndefined();
    expect(byPreview["expired"].status).toBe("unconfirmed");
    expect(byPreview["withdrawn"].status).toBe("cancelled");
  });

  test("a target flooded by other senders still shows your sends", async () => {
    const { t, ids, send, status } = await setup({ session: { agent_status: "idle", tmux_session: "cc-recv" } });
    await send({ body: "mine" });
    await t.run(async (ctx) => {
      const other = await ctx.db.insert("conversations", { user_id: ids.user, agent_type: "claude_code", started_at: Date.now(), short_id: "jx7cron" } as any);
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("pending_messages", { conversation_id: ids.recipient, from_user_id: ids.user, from_conversation_id: other, content: "tick", status: "delivered", created_at: Date.now(), retry_count: 0 } as any);
      }
    });
    expect((await status()).sends.map((s) => s.preview)).toEqual(["mine"]);
  });

  test("another session's sends to the same target are not listed", async () => {
    const { t, ids, status } = await setup({ session: { agent_status: "idle", tmux_session: "cc-recv" } });
    await t.run(async (ctx) => {
      const other = await ctx.db.insert("conversations", { user_id: ids.user, agent_type: "claude_code", started_at: Date.now(), short_id: "jx7othr" } as any);
      await ctx.db.insert("pending_messages", { conversation_id: ids.recipient, from_user_id: ids.user, from_conversation_id: other, content: "not mine", status: "pending", created_at: Date.now(), retry_count: 0 } as any);
    });
    expect((await status()).sends).toEqual([]);
  });

  test("a sender that is not the caller's own session is refused", async () => {
    const { t } = await setup({ session: null });
    await expect(t.query(api.pendingMessages.sendStatus, { to: "jx7recv", from: "jx7nope", api_token: TOKEN })).rejects.toThrow(/Sender session/);
  });
});

describe("sendArrival", () => {
  const busy = { status: "working", ready: false, typeAhead: true };
  const base = { safetyBlocked: false, runLog: false, hosted: false, sessions: [busy], queued: false, ownerOnline: true };
  test("a run's log never takes it", () => expect(sendArrival({ ...base, runLog: true })).toBe("never"));
  test("a stopped row beside a working one does not decide", () => expect(sendArrival({ ...base, sessions: [{ status: "stopped", ready: false, typeAhead: true }, busy] })).toBe("next_tool_call"));
  test("a starting row beats a prompt-blocked one", () => expect(sendArrival({ ...base, sessions: [{ status: "permission_blocked", ready: false, typeAhead: true }, { status: "starting", ready: false, typeAhead: true }] })).toBe("after_start"));
  test("a safety stop holds everything", () => expect(sendArrival({ ...base, safetyBlocked: true, sessions: [{ ...busy, ready: true }] })).toBe("held"));
  test("Queue for later waits for the end of the turn", () => expect(sendArrival({ ...base, queued: true })).toBe("end_of_turn"));
  test("compacting waits for the end of the turn", () => expect(sendArrival({ ...base, sessions: [{ ...busy, status: "compacting" }] })).toBe("end_of_turn"));
  test("any settled process takes it now", () => expect(sendArrival({ ...base, sessions: [busy, { status: "idle", ready: true, typeAhead: false }] })).toBe("now"));
  test("a hosted conversation's engine is woken by the enqueue", () => expect(sendArrival({ ...base, hosted: true, sessions: [], ownerOnline: false })).toBe("now"));
});

describe("a sender name with > keeps the intent readable", () => {
  test("the opening tag is read attribute by attribute", async () => {
    const { formatSessionMessage } = await import("@codecast/shared/contracts");
    expect(sessionMessageIntentOf(formatSessionMessage("jx7send", "x", { name: "a>b", intent: "done" }))).toBe("done");
  });
});
