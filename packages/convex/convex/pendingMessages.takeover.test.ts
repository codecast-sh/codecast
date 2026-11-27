import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { enqueuePendingMessage } from "./pendingMessages";
import { finalizeAnswer } from "./sessionDecisions";

setDefaultTimeout(60_000);

// pl-1134: a message that reaches a session inside its parent's process takes
// it over (the parent is released and told once to stop its copy); a message
// from another session is refused, naming the parent.

const TOKEN = "takeover-token";
const AGENT = "a8665f73ab2350b5e";
// What the parent reads: a person named only when one took it over.
const REACH = `It now continues as its own session jxkid01. If it is still running, stop it with TaskStop ${AGENT}. Do not SendMessage it again; reach it with \`cast send jxkid01\`.`;
const BY_JASON = `Jason took over your subagent "bg wait test" (agent ${AGENT}). ${REACH}`;
const HANDED = `Your subagent "bg wait test" (agent ${AGENT}) was handed a message and now continues as its own session jxkid01. If it is still running, stop it with TaskStop ${AGENT}. Do not SendMessage it again; reach it with \`cast send jxkid01\`.`;

async function world(opts: { owners?: boolean; team?: boolean } = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const me = await ctx.db.insert("users", { name: "Jason", emailVerificationTime: 1, notifications_enabled: true, push_token: "tok-me" } as any);
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    let team: any;
    if (opts.owners || opts.team) {
      team = await ctx.db.insert("teams", { name: "Acme", features: opts.owners ? { session_owners: true } : {} } as any);
      await ctx.db.insert("team_memberships", { user_id: me, team_id: team, role: "admin", joined_at: 1 } as any);
    }
    const mate = await ctx.db.insert("users", { name: "Mira", emailVerificationTime: 1 } as any);
    if (team) await ctx.db.insert("team_memberships", { user_id: mate, team_id: team, role: "member", joined_at: 1 } as any);
    const base = { user_id: me, agent_type: "claude_code", project_path: "/tmp/p", started_at: now, updated_at: now, message_count: 2, status: "active", ...(team ? { team_id: team } : {}) };
    const parent = await ctx.db.insert("conversations", { ...base, session_id: "86a160aa-623c-4db9-9ce0-f1f1c403cace", short_id: "jxpar01", runs_in_parent: false } as any);
    const child = await ctx.db.insert("conversations", {
      ...base, session_id: `agent-${AGENT}`, short_id: "jxkid01", parent_conversation_id: parent, is_subagent: true, runs_in_parent: true, subagent_description: "bg wait test",
    } as any);
    const ownProcess = await ctx.db.insert("conversations", {
      ...base, session_id: "0b6e2c1a-0000-4000-8000-000000000001", short_id: "jxown01", parent_conversation_id: parent, is_subagent: true, runs_in_parent: false,
    } as any);
    return { me, mate, parent, child, ownProcess };
  });
  const personSend = (conversation_id: any, content: string) =>
    t.mutation(api.pendingMessages.sendMessageToSession, { conversation_id, content, human: true, api_token: TOKEN });
  const parentLines = () => t.run(async (ctx) =>
    (await ctx.db.query("pending_messages").collect()).filter((r: any) => String(r.conversation_id) === String(ids.parent)).map((r: any) => r.content as string));
  const row = (id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<any>;
  return { t, ids, personSend, parentLines, row };
}

describe("a person's message to an in-process child", () => {
  test("releases it from its parent and tells the parent once", async () => {
    const w = await world();
    await w.personSend(w.ids.child, "take it from here");
    expect((await w.row(w.ids.child)).parent_released_at).toBeNumber();
    const lines = await w.parentLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(BY_JASON);
    // The person's message itself waits for the child's promotion.
    const mine = await w.t.run(async (ctx) => (await ctx.db.query("pending_messages").collect()).filter((r: any) => String(r.conversation_id) === String(w.ids.child)));
    expect(mine.map((r: any) => r.content)).toEqual(["take it from here"]);

    await w.personSend(w.ids.child, "and one more thing");
    expect(await w.parentLines()).toHaveLength(1);
  });

  test("under session owners it is the take-over change: the person owns it and the parent hears once", async () => {
    const w = await world({ owners: true });
    await w.personSend(w.ids.child, "take it from here");
    await w.personSend(w.ids.child, "again");
    expect((await w.row(w.ids.child)).parent_released_at).toBeNumber();
    expect((await w.row(w.ids.child)).owners_changed_at).toBeNumber();
    const owners = await w.t.run(async (ctx) => (await ctx.db.query("session_owners").collect()).filter((r: any) => String(r.conversation_id) === String(w.ids.child)));
    expect(owners.map((r: any) => String(r.user_id))).toEqual([String(w.ids.me)]);
    const told = (await w.parentLines()).filter((l) => l.includes('"bg wait test"'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(BY_JASON);
  });

  test("under session owners, a sender who may not edit its owners only releases it, through the owners write", async () => {
    const w = await world({ owners: true });
    await w.t.run(async (ctx) => { await enqueuePendingMessage(ctx, (await ctx.db.get(w.ids.child))!, w.ids.mate, { content: "a teammate's note", human: true }); });
    const child = await w.row(w.ids.child);
    expect(child.parent_released_at).toBeNumber();
    expect(child.owners_changed_at).toBeNumber();
    const owners = await w.t.run(async (ctx) => (await ctx.db.query("session_owners").collect()).filter((r: any) => String(r.conversation_id) === String(w.ids.child)));
    expect(owners.map((r: any) => String(r.user_id))).not.toContain(String(w.ids.mate));
    // Mira released it without owning it: the parent is not told she took it over.
    const told = (await w.parentLines()).filter((l) => l.includes('"bg wait test"'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(HANDED);
    expect(told[0]).not.toContain("Mira");
  });

  test("Take it over without a message releases it and tells the parent the same way", async () => {
    const w = await world({ owners: true });
    await w.t.mutation(api.sessionOwnership.applyOwnersChange, { session_id: "jxkid01", take_over: true, api_token: TOKEN });
    expect((await w.row(w.ids.child)).parent_released_at).toBeNumber();
    await w.personSend(w.ids.child, "now the message");
    const told = (await w.parentLines()).filter((l) => l.includes('"bg wait test"'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(BY_JASON);
  });

  test("releasing the parent in the owners menu, or `cast disown parent`, tells the parent who released it", async () => {
    const released = `Jason released your subagent "bg wait test" (agent ${AGENT}) from you; it continues as its own session jxkid01 when it next gets a message. If it is still running, stop it with TaskStop ${AGENT}. Do not SendMessage it again; reach it with \`cast send jxkid01\`.`;
    const menu = await world({ owners: true });
    await menu.t.mutation(api.sessionOwnership.applyOwnersChange, { session_id: "jxkid01", release_parent: true, api_token: TOKEN });
    expect((await menu.row(menu.ids.child)).parent_released_at).toBeNumber();
    const told = await menu.parentLines();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(released);
    // Its next message finds it released: the parent is not told again.
    await menu.personSend(menu.ids.child, "now the message");
    expect(await menu.parentLines()).toHaveLength(1);

    const disown = await world({ owners: true });
    await disown.t.run((ctx) => ctx.db.patch(disown.ids.child, { session_id: "agent-areview-mobile-fe89e5471ddad254", subagent_description: "Review phone app" } as any));
    await disown.t.mutation(api.sessionOwnership.removeSessionOwner, { session_id: "jxkid01", owner: "parent", api_token: TOKEN });
    expect((await disown.parentLines())[0]).toContain('Jason released your agent review-mobile ("Review phone app", agent id areview-mobile-fe89e5471ddad254) from you; it continues as its own session jxkid01 when it next gets a message. If it is still running, stop it with TaskStop areview-mobile-fe89e5471ddad254. Do not SendMessage review-mobile again; reach it with `cast send jxkid01`.');
  });

  test("wakes a parent whose prompt cache went cold: a copy running inside it is what the message waits on", async () => {
    const w = await world();
    const longAgo = Date.now() - 3 * 60 * 60 * 1000;
    await w.t.run((ctx) => ctx.db.patch(w.ids.parent, { updated_at: longAgo, usage_totals: { updated_at: longAgo, context_tokens: 150_000 } } as any));
    await w.personSend(w.ids.child, "take it from here");
    const rows = await w.t.run(async (ctx) => (await ctx.db.query("pending_messages").collect()).filter((r: any) => String(r.conversation_id) === String(w.ids.parent)));
    expect(rows.map((r: any) => r.status)).toEqual(["pending"]);
  });

  test("a named agent's parent is told the name it sends to and the id TaskStop takes", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.ids.child, { session_id: "agent-areview-mobile-fe89e5471ddad254", subagent_description: "Review phone app" } as any));
    await w.personSend(w.ids.child, "take it from here");
    expect((await w.parentLines())[0]).toContain('Jason took over your agent review-mobile ("Review phone app", agent id areview-mobile-fe89e5471ddad254). It now continues as its own session jxkid01. If it is still running, stop it with TaskStop areview-mobile-fe89e5471ddad254. Do not SendMessage review-mobile again; reach it with `cast send jxkid01`.');
  });

  test("a child with its own process is a plain send", async () => {
    const w = await world();
    await w.personSend(w.ids.ownProcess, "hello");
    expect((await w.row(w.ids.ownProcess)).parent_released_at).toBeUndefined();
    expect(await w.parentLines()).toEqual([]);
  });
});

describe("another session's message to an in-process child", () => {
  test("is refused, naming the parent to message instead", async () => {
    const w = await world();
    await expect(w.t.mutation(api.pendingMessages.sendSessionMessage, { to: "jxkid01", from: "jxpar01", body: "status?", api_token: TOKEN }))
      .rejects.toThrow("jxkid01 runs inside jxpar01's process; message its parent instead.");
    expect((await w.row(w.ids.child)).parent_released_at).toBeUndefined();
  });
  test("goes through once a person released it: the parent's notice names that `cast send`", async () => {
    const w = await world();
    await w.personSend(w.ids.child, "take it from here");
    const sent = await w.t.mutation(api.pendingMessages.sendSessionMessage, { to: "jxkid01", from: "jxpar01", body: "here is what I had", api_token: TOKEN });
    expect(sent.message_id).toBeTruthy();
  });
  test("reaches a child with its own process as before", async () => {
    const w = await world();
    const sent = await w.t.mutation(api.pendingMessages.sendSessionMessage, { to: "jxown01", from: "jxpar01", body: "status?", api_token: TOKEN });
    expect(sent.message_id).toBeTruthy();
  });
});

describe("the daemon's rebind of a promoted child", () => {
  test("moving a claude row off its agent id onto a UUID clears runs_in_parent", async () => {
    const w = await world();
    await w.t.mutation(api.conversations.updateSessionId, { conversation_id: w.ids.child, session_id: "5f0c3c1e-8d0a-4a51-9c6e-2b1f0e7d9a10", api_token: TOKEN });
    const child = await w.row(w.ids.child);
    expect(child.session_id).toBe("5f0c3c1e-8d0a-4a51-9c6e-2b1f0e7d9a10");
    expect(child.runs_in_parent).toBe(false);
  });
  test("a named agent's rebind clears it too", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.ids.child, { session_id: "agent-areview-mobile-fe89e5471ddad254" } as any));
    await w.t.mutation(api.conversations.updateSessionId, { conversation_id: w.ids.child, session_id: "5f0c3c1e-8d0a-4a51-9c6e-2b1f0e7d9a10", api_token: TOKEN });
    expect((await w.row(w.ids.child)).runs_in_parent).toBe(false);
  });
  test("any other rebind leaves it alone", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.ids.child, { session_id: `agent-${AGENT}`, runs_in_parent: true }));
    await w.t.mutation(api.conversations.updateSessionId, { conversation_id: w.ids.child, session_id: "agent-b000000000000001", api_token: TOKEN });
    expect((await w.row(w.ids.child)).runs_in_parent).toBe(true);
  });
});

describe("a child a person took over off the owners model", () => {
  // The two halves of pl-1134 meet here: the takeover stamps parent_released_at,
  // and the hearing gates stop silencing a released child.
  test("is heard when it settles waiting, where before the takeover it stood down", async () => {
    const w = await world({ team: true });
    const settle = () => w.t.run(async (ctx) => {
      const now = Date.now();
      for (const r of await ctx.db.query("pending_messages").collect()) if (String(r.conversation_id) === String(w.ids.child)) await ctx.db.delete(r._id);
      await ctx.db.patch(w.ids.child, { has_pending_messages: false, last_message_role: "assistant", message_count: 5, updated_at: now - 120_000, needs_input_notified_key: undefined, status: "active" } as any);
      for (const m of await ctx.db.query("managed_sessions").collect()) await ctx.db.delete(m._id);
      await ctx.db.insert("managed_sessions", { user_id: w.ids.me, conversation_id: w.ids.child, session_id: `agent-${AGENT}`, agent_status: "idle", agent_status_updated_at: now - 60_000, last_heartbeat: now - 5_000 } as any);
      await ctx.db.insert("messages", { conversation_id: w.ids.child, role: "assistant", content: "Done. What next?", timestamp: now - 70_000 } as any);
    });
    const check = async () => {
      const res: any = await w.t.mutation(internal.notifications.checkNeedsInput, { conversation_id: w.ids.child });
      return { notified: res?.notified === true, reason: res?.reason };
    };

    await settle();
    expect(await check()).toEqual({ notified: false, reason: "subagent" });

    await w.personSend(w.ids.child, "take it from here");
    expect((await w.row(w.ids.child)).parent_released_at).toBeNumber();
    await settle();
    expect((await check()).notified).toBe(true);
  });
});

describe("a message that is not a person's into an in-process child", () => {
  // The daemon resumes the child for any message it delivers, so every one
  // that reaches it takes it over, not only a person's.
  test("a decision a role answers takes it over and tells the parent once", async () => {
    const w = await world();
    const decision = await w.t.run((ctx) => ctx.db.insert("session_decisions", {
      conversation_id: w.ids.child, session_id: `agent-${AGENT}`, user_id: w.ids.me, question: "Ship it?",
      options: [{ label: "Yes" }, { label: "No" }], blocking: true, status: "pending", created_at: Date.now(),
    } as any));
    await w.t.run(async (ctx) => {
      await finalizeAnswer(ctx as any, (await ctx.db.get(decision))!, { status: "answered", answer_index: 0 } as any, { kind: "role", id: "or-1", user_id: w.ids.me }, { deliver: true });
    });
    expect((await w.row(w.ids.child)).parent_released_at).toBeNumber();
    const told = await w.parentLines();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(HANDED);
  });

  test("a machine's line takes it over; a held note waits", async () => {
    const w = await world();
    const child = () => w.t.run((ctx) => ctx.db.get(w.ids.child)) as Promise<any>;
    await w.t.run(async (ctx) => { await enqueuePendingMessage(ctx, (await ctx.db.get(w.ids.child))!, w.ids.me, { content: "for the record", hold: true }); });
    expect((await child()).parent_released_at).toBeUndefined();
    expect(await w.parentLines()).toEqual([]);
    await w.t.run(async (ctx) => { await enqueuePendingMessage(ctx, (await ctx.db.get(w.ids.child))!, w.ids.me, { content: "continue", origin: "scheduler" }); });
    expect((await child()).parent_released_at).toBeNumber();
    const told = await w.parentLines();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(HANDED);
    expect(told[0]).not.toContain("Jason");
  });

  test("a named agent handed a message is told by name, without a person", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.ids.child, { session_id: "agent-areview-mobile-fe89e5471ddad254", subagent_description: "Review phone app" } as any));
    await w.t.run(async (ctx) => { await enqueuePendingMessage(ctx, (await ctx.db.get(w.ids.child))!, w.ids.me, { content: "continue", origin: "scheduler" }); });
    expect((await w.parentLines())[0]).toContain('Your agent review-mobile ("Review phone app", agent id areview-mobile-fe89e5471ddad254) was handed a message and now continues as its own session jxkid01. If it is still running, stop it with TaskStop areview-mobile-fe89e5471ddad254. Do not SendMessage review-mobile again; reach it with `cast send jxkid01`.');
  });
});
