// Live artifacts under convex-test: a person (web identity) and an agent
// session (CLI token + session id) write the same board; both converge on the
// server's order, the agent's writes carry its session identity and cursor,
// drafts save and discard, history restores, and access follows the doc's
// workspace.
import { describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { presentToken } from "@platform/auth/convex";

setDefaultTimeout(120_000);

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const rosa = await ctx.db.insert("users", { name: "Rosa", email: "rosa@pies.dev" } as any);
    const dev = await ctx.db.insert("users", { name: "Dev", email: "dev@pies.dev" } as any);
    const outsider = await ctx.db.insert("users", { name: "Out", email: "out@else.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Pies", invite_code: "PIES1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: rosa, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: dev, team_id: team, role: "member", joined_at: 1 } as any);
    const doc = await ctx.db.insert("docs", {
      user_id: rosa, team_id: team, workspace: `team:${team}`, title: "Launch timeline", content: "", doc_type: "board",
      source: "human", created_at: 1, updated_at: 1,
    } as any);
    const privateDoc = await ctx.db.insert("docs", {
      user_id: rosa, team_id: team, workspace: `user:${rosa}`, title: "Rosa's sheet", content: "", doc_type: "sheet",
      source: "human", created_at: 1, updated_at: 1,
    } as any);
    const note = await ctx.db.insert("docs", {
      user_id: rosa, team_id: team, workspace: `team:${team}`, title: "A note", content: "hi", doc_type: "note",
      source: "human", created_at: 1, updated_at: 1,
    } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: dev, agent_type: "claude_code", session_id: "sess-agent-1", started_at: 1, updated_at: 1, message_count: 0,
      is_private: false, status: "active", team_id: team, short_id: "jx7agnt", title: "Lay out the timeline",
    } as any);
    await ctx.db.insert("api_tokens", { user_id: dev, token_hash: await hashToken("dev_clisecret"), name: "mac", created_at: 1, last_used_at: 1 } as any);
    return { rosa, dev, outsider, team, doc, privateDoc, note, conv };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  const agent = { api_token: presentToken("dev_clisecret"), session_id: "sess-agent-1" };
  return { t, ...ids, as, agent };
}

const state = async (t: any, doc: Id<"docs">, layer = "main") =>
  Object.fromEntries(
    (await t.run((ctx: any) => ctx.db.query("live_elements").withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", doc).eq("layer", layer)).collect()))
      .filter((r: any) => !r.dead)
      .map((r: any) => [r.key, r.deleted ? "deleted" : { kind: r.kind, ...r.fields }]),
  );

describe("live artifacts", () => {
  test("a person and an agent session write at once and converge field by field", async () => {
    const { t, doc, rosa, as, agent, conv } = await setup();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 0, y: 0, text: "" } }] });
    // Concurrent: Rosa drags, the agent writes text and nudges x.
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", set: { x: 100, y: 50 } }] });
    const r = await t.mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", set: { text: "Lock pricing", x: 7 } }, { k: "el_b", put: { kind: "sticky", x: 300, y: 0 } }], ...agent });
    expect(r.keys).toEqual(["el_a", "el_b"]);
    expect(await state(t, doc)).toEqual({
      el_a: { kind: "sticky", x: 7, y: 50, text: "Lock pricing" },
      el_b: { kind: "sticky", x: 300, y: 0 },
    });

    // The tail is one index range: everything after a revision, revisions unique.
    const all = await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 });
    expect(all!.head).toBe(4);
    const revs = all!.rows.map((x: any) => x.rev);
    expect(new Set(revs).size).toBe(revs.length);
    const tail = await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 3 });
    expect(tail!.rows.map((x: any) => x.key)).toEqual(["el_b"]);

    // The agent's write is signed by its session and its cursor sits on what it wrote.
    expect(all!.rows.find((x: any) => x.key === "el_b")!.by).toBe(`s:${conv}`);
    const people = await as(rosa).query(api.livePresence.presence, { doc_id: doc });
    const bot = people!.find((p: any) => p.kind === "agent")!;
    expect(bot).toMatchObject({ name: "Lay out the timeline", session_short_id: "jx7agnt", selection: ["el_a", "el_b"] });
  });

  test("the server refuses kinds the product does not register and reserved fields", async () => {
    const { doc, rosa, as } = await setup();
    await expect(as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_x", put: { kind: "cell", input: "1" } }] })).rejects.toThrow(/not a board element/);
    await expect(as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_x", put: { kind: "sticky", rev: 9 } }] })).rejects.toThrow(/reserved/);
  });

  test("access follows the doc's workspace", async () => {
    const { t, doc, privateDoc, note, rosa, dev, outsider, as } = await setup();
    const op = [{ k: "el_a", put: { kind: "sticky", x: 1 } }];
    // A team doc: both members read and write; an outsider gets nothing.
    await as(dev).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: op });
    expect(await as(outsider).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 })).toBeNull();
    expect(await as(outsider).query(api.livePresence.presence, { doc_id: doc })).toBeNull();
    await expect(as(outsider).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: op })).rejects.toThrow();
    await expect(as(outsider).mutation(api.livePresence.setPresence, { doc_id: doc, tab: "t" })).rejects.toThrow();
    // A doc private to Rosa inside the team: her teammate cannot open it.
    expect(await as(dev).query(api.liveArtifacts.elementsSince, { doc_id: privateDoc, since: 0 })).toBeNull();
    await expect(as(dev).mutation(api.liveArtifacts.apply, { doc_id: privateDoc, ops: [{ k: "c:Sheet1!A1", put: { kind: "cell", input: "1" } }] })).rejects.toThrow();
    expect(await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: privateDoc, since: 0 })).not.toBeNull();
    // A prose doc is not an artifact.
    await expect(as(rosa).mutation(api.liveArtifacts.apply, { doc_id: note, ops: op })).rejects.toThrow(/not a board/);
    // No identity, no write.
    await expect(t.mutation(api.liveArtifacts.apply, { doc_id: doc, ops: op })).rejects.toThrow();
  });

  test("an agent session's token cannot sign as a session it does not run", async () => {
    const { t, doc, rosa, as, agent, team } = await setup();
    const rosasSession = await t.run((ctx: any) => ctx.db.insert("conversations", {
      user_id: rosa, agent_type: "claude_code", session_id: "sess-rosa", started_at: 1, updated_at: 1, message_count: 0, is_private: false, status: "active", team_id: team, title: "Rosa's agent",
    }));
    const r = await t.mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_z", put: { kind: "sticky", x: 1 } }], api_token: agent.api_token, session_id: "sess-rosa" });
    expect(r.keys).toEqual(["el_z"]);
    const rows = await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 });
    expect(rows!.rows[0].by.startsWith("u:")).toBe(true);
  });

  test("a draft is held until saved, and discard drops it", async () => {
    const { t, doc, rosa, as, agent } = await setup();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 0, text: "v1" } }] });
    await t.mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_a", set: { text: "v2" } }, { k: "el_n", put: { kind: "sticky", x: 9 } }], ...agent });
    expect(await state(t, doc)).toEqual({ el_a: { kind: "sticky", x: 0, text: "v1" } });
    expect(await state(t, doc, "draft")).toEqual({ el_a: { kind: "sticky", x: 0, text: "v2" }, el_n: { kind: "sticky", x: 9 } });
    const page = await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 });
    expect(page!.draft).toMatchObject({ by_name: "Lay out the timeline" });

    expect(await as(rosa).mutation(api.liveArtifacts.draftSave, { doc_id: doc })).toMatchObject({ saved: 2 });
    expect(await state(t, doc)).toEqual({ el_a: { kind: "sticky", x: 0, text: "v2" }, el_n: { kind: "sticky", x: 9 } });
    expect(await state(t, doc, "draft")).toEqual({});
    // Retired draft rows reach clients as dead rows on the tail.
    const tail = await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: page!.head });
    expect(tail!.rows.filter((r: any) => r.dead).map((r: any) => r.key).sort()).toEqual(["el_a", "el_n"]);
    expect(tail!.draft).toBeNull();

    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_a", del: true }] });
    expect(await as(rosa).mutation(api.liveArtifacts.draftDiscard, { doc_id: doc })).toEqual({ discarded: 1 });
    expect((await state(t, doc)).el_a).toEqual({ kind: "sticky", x: 0, text: "v2" });
  });

  test("history restores an earlier version as an ordinary write", async () => {
    const { t, doc, rosa, as } = await setup();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 0, text: "first" } }] });
    const { rev } = await as(rosa).mutation(api.liveArtifacts.checkpoint, { doc_id: doc, label: "Good" });
    await t.finishAllScheduledFunctions(() => {});
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", set: { text: "second" } }, { k: "el_b", put: { kind: "sticky", x: 5 } }] });
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_c", put: { kind: "sticky", x: 6 } }] });

    const then = await as(rosa).action(api.liveArtifacts.stateAt, { doc_id: doc, rev });
    expect(then).toEqual([{ key: "el_a", kind: "sticky", fields: { x: 0, text: "first" } }]);

    const r = await as(rosa).action(api.liveArtifacts.restore, { doc_id: doc, rev });
    expect(r.changed).toBe(3);
    expect(await state(t, doc)).toEqual({ el_a: { kind: "sticky", x: 0, text: "first" }, el_b: "deleted", el_c: "deleted" });
    await t.finishAllScheduledFunctions(() => {});
    const versions = await as(rosa).query(api.liveArtifacts.versions, { doc_id: doc });
    expect(versions!.versions.map((v: any) => v.label)).toEqual([`Restored to r${rev}`, "Before restore", "Good"]);
    // The pre-restore version can itself be restored.
    const before = versions!.versions[1].rev;
    await as(rosa).action(api.liveArtifacts.restore, { doc_id: doc, rev: before });
    expect((await state(t, doc)).el_b).toEqual({ kind: "sticky", x: 5 });
  });

  test("a restore too big for one transaction lands in chunks and clears its marker", async () => {
    const { t, doc, rosa, as } = await setup();
    const { rev } = await as(rosa).mutation(api.liveArtifacts.checkpoint, { doc_id: doc, label: "Empty" });
    // 1600 stickies: over the one-transaction restore limit (1500 ops).
    for (let b = 0; b < 4; b++) {
      const ops = Array.from({ length: 400 }, (_, i) => ({ k: `el_${b}_${i}`, put: { kind: "sticky", x: i } }));
      await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops });
    }
    await t.finishAllScheduledFunctions(() => {});
    const r = await as(rosa).action(api.liveArtifacts.restore, { doc_id: doc, rev });
    expect(r.changed).toBe(1600);
    expect(Object.values(await state(t, doc)).every((s) => s === "deleted")).toBe(true);
    const page = await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: r.rev });
    expect(page!.restoring).toBeNull();
  });

  test("a chunked restore that stopped partway shows on the tail until finished", async () => {
    const { t, doc, rosa, as } = await setup();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 0 } }] });
    const { rev } = await as(rosa).mutation(api.liveArtifacts.checkpoint, { doc_id: doc });
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_b", put: { kind: "sticky", x: 1 } }, { k: "el_c", put: { kind: "sticky", x: 2 } }] });
    await t.finishAllScheduledFunctions(() => {});
    const head = (await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 }))!.head;
    // The first of two chunks lands, then the action dies.
    await t.mutation(internal.liveArtifacts.applyRestore, {
      doc_id: doc, rev, ops: [{ k: "el_b", del: true }], expect_head: head, first: true, last: false, chunked: true,
      caller: { userId: rosa, actor: `u:${rosa}`, name: "Rosa", kind: "person" },
    });
    const stuck = await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 });
    expect(stuck!.restoring).toMatchObject({ to: rev, from: head, by_name: "Rosa" });
    // Finishing it is the same restore again; the marker goes and no second "Before restore" is written.
    await as(rosa).action(api.liveArtifacts.restore, { doc_id: doc, rev });
    expect(await state(t, doc)).toEqual({ el_a: { kind: "sticky", x: 0 }, el_b: "deleted", el_c: "deleted" });
    expect((await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 }))!.restoring).toBeNull();
    await t.finishAllScheduledFunctions(() => {});
    const labels = (await as(rosa).query(api.liveArtifacts.versions, { doc_id: doc }))!.versions.map((v: any) => v.label);
    expect(labels.filter((l: string) => l === "Before restore")).toHaveLength(1);
  });

  test("comments notify who they name, the thread, and the owner; an agent's reply answers an ask", async () => {
    const { t, doc, rosa, dev, as, agent, conv } = await setup();
    const bell = async (user: Id<"users">) =>
      (await t.run((ctx: any) => ctx.db.query("notifications").collect())).filter((n: any) => String(n.recipient_user_id) === String(user)).map((n: any) => `${n.type}: ${n.message}`);

    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_1", put: { kind: "comment", text: "@dev can you check the dates?" } }] });
    expect(await bell(dev)).toEqual(['mention: Rosa mentioned you on the board "Launch timeline"']);

    // A new thread nobody is named in reaches the owner.
    await as(dev).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_2", put: { kind: "comment", text: "Looks right" } }] });
    expect(await bell(rosa)).toEqual(['doc_commented: Dev commented on the board "Launch timeline"']);

    // Naming a session hands it the comment as an ask and records where it went.
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_3", put: { kind: "comment", text: "@[Lay out the timeline jx7agnt] add the launch day" } }] });
    const sent = await t.run((ctx: any) => ctx.db.query("pending_messages").collect());
    expect(sent.some((m: any) => String(m.conversation_id) === String(conv) && m.content.includes("cm_3") && m.content.includes("add the launch day"))).toBe(true);
    expect((await state(t, doc, "comments")).cm_3).toMatchObject({ sent_to: String(conv) });

    // The agent's reply reaches the asker and marks the ask answered.
    await t.mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_4", put: { kind: "comment", text: "Added Day 0", parent: "cm_3" } }], ...agent });
    expect(await bell(rosa)).toContain('comment_reply: Lay out the timeline replied on the board "Launch timeline"');
    expect((await state(t, doc, "comments")).cm_3).toMatchObject({ answered_by_name: "Lay out the timeline" });
  });

  test("create from a team session: --personal keeps it the creator's, no flag follows the session", async () => {
    const { t, dev, team } = await setup();
    const token = presentToken("dev_clisecret");
    const base = { api_token: token, title: "Forecast", content: "", doc_type: "sheet", conversation_id: "sess-agent-1" };
    const personal = await t.mutation(api.docs.create, { ...base, workspace: "personal" });
    const followed = await t.mutation(api.docs.create, base);
    const explicit = await t.mutation(api.docs.create, { ...base, workspace: "team", team_id: team });
    const ws = async (id: any) => (await t.run((ctx: any) => ctx.db.get(id))).workspace;
    expect(await ws(personal.id)).toBe(`user:${dev}`);
    expect(await ws(followed.id)).toBe(`team:${team}`);
    expect(await ws(explicit.id)).toBe(`team:${team}`);
  });

  test("steady editing leaves an autosave every ten minutes; a quiet spell leaves 'Before edits'", async () => {
    const { t, doc, rosa, as } = await setup();
    const start = Date.now();
    try {
      for (let i = 0; i <= 3; i++) {
        setSystemTime(new Date(start + i * 4 * 60_000));
        await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: `el_${i}`, put: { kind: "sticky", x: i } }] });
      }
      let labels = (await as(rosa).query(api.liveArtifacts.versions, { doc_id: doc }))!.versions.map((v: any) => v.label);
      expect(labels).toEqual(["Autosave"]);
      setSystemTime(new Date(start + 30 * 60_000));
      await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_z", put: { kind: "sticky", x: 9 } }] });
      labels = (await as(rosa).query(api.liveArtifacts.versions, { doc_id: doc }))!.versions.map((v: any) => v.label);
      expect(labels).toEqual(["Before edits", "Autosave"]);
    } finally {
      setSystemTime();
    }
  });

  test("the head counts the rows a complete copy holds, through deletes, drafts and old heads", async () => {
    const { t, doc, rosa, as } = await setup();
    const total = async () => (await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 }))!.total;
    const stored = async () => (await t.run((ctx: any) => ctx.db.query("live_elements").withIndex("by_doc_rev", (q: any) => q.eq("doc_id", doc)).collect())).filter((r: any) => !r.dead).length;
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 0 } }, { k: "el_b", put: { kind: "sticky", x: 1 } }] });
    expect(await total()).toBe(2);
    // A delete leaves a tombstone row: still counted.
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_b", del: true }] });
    expect(await total()).toBe(2);
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_a", set: { x: 5 } }, { k: "el_c", put: { kind: "sticky", x: 2 } }] });
    expect(await total()).toBe(4);
    await as(rosa).mutation(api.liveArtifacts.draftDiscard, { doc_id: doc });
    expect(await total()).toBe(2);
    // A draft row revived after it was retired counts again.
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_a", set: { x: 6 } }] });
    expect(await total()).toBe(3);
    expect(await total()).toBe(await stored());

    // A head from before the count: unknown until its next write counts it.
    await t.run(async (ctx: any) => {
      const head = await ctx.db.query("live_heads").withIndex("by_doc", (q: any) => q.eq("doc_id", doc)).first();
      await ctx.db.patch(head._id, { rows: undefined });
    });
    expect(await total()).toBeNull();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_d", put: { kind: "sticky", x: 3 } }] });
    await new Promise((r) => setTimeout(r, 20));
    await t.finishAllScheduledFunctions(() => {});
    expect(await total()).toBe(await stored());
  });

  test("search finds an artifact by the words inside it, only in the viewer's workspaces", async () => {
    const { t, doc, privateDoc, rosa, dev, outsider, as } = await setup();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 0, text: "Ship on Friday" } }] });
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: privateDoc, ops: [{ k: "c:Sheet1!A1", put: { kind: "cell", input: "Friday budget" } }, { k: "c:Sheet1!A2", put: { kind: "cell", input: "=SUM(Fridays)" } }] });
    // The writes asked for a reindex SEARCH_REINDEX_MS out; run it now.
    for (const d of [doc, privateDoc]) await t.mutation(internal.liveSearch.reindex, { doc_id: d });
    const find = async (who: any, q: string) => (await as(who).query(api.liveSearch.search, { query: q })).map((h: any) => h.title).sort();
    expect(await find(rosa, "friday")).toEqual(["Launch timeline", "Rosa's sheet"]);
    // A teammate finds the team board, not Rosa's personal sheet; an outsider finds nothing.
    expect(await find(dev, "friday")).toEqual(["Launch timeline"]);
    expect(await find(outsider, "friday")).toEqual([]);
    // Formulas are not words.
    expect(await find(rosa, "SUM")).toEqual([]);
    const [hit] = await as(rosa).query(api.liveSearch.search, { query: "ship" });
    expect(hit.snippet).toContain("Ship on Friday");
  });

  test("a comment's words are its author's; thread state is anyone's; your own agent's reply reaches you", async () => {
    const { t, doc, rosa, dev, as, agent } = await setup();
    await as(dev).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_d", put: { kind: "comment", text: "Dev's note", sent_to: "x" } }] });
    // Rosa (the owner) can resolve it and delete it, but not rewrite it or replace it.
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_d", set: { resolved: true } }] });
    await expect(as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_d", set: { text: "edited" } }] })).rejects.toThrow(/Only its author can edit/);
    await expect(as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_d", put: { kind: "comment", text: "mine now" } }] })).rejects.toThrow(/can't be replaced/);
    // Rosa's comment: Dev may not delete it.
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_r", put: { kind: "comment", text: "Rosa's note" } }] });
    await expect(as(dev).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_r", del: true }] })).rejects.toThrow(/Only its author can delete/);
    // Dev's own agent session replies on Dev's ask: Dev hears about it.
    await t.mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_a", put: { kind: "comment", text: "Done", parent: "cm_d" } }], ...agent });
    const devBell = (await t.run((ctx: any) => ctx.db.query("notifications").collect())).filter((n: any) => String(n.recipient_user_id) === String(dev));
    expect(devBell.map((n: any) => n.type)).toContain("comment_reply");
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_d", del: true }] });
  });

  test("the owner can limit editing: others view and comment, named editors still edit", async () => {
    const { t, doc, rosa, dev, as, agent } = await setup();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 0 } }] });
    await expect(as(dev).mutation(api.liveArtifacts.setEditAccess, { doc_id: doc, edit: "owners" })).rejects.toThrow(/Only the artifact's owner/);
    await as(rosa).mutation(api.liveArtifacts.setEditAccess, { doc_id: doc, edit: "owners" });
    expect((await as(dev).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 }))!.can_edit).toBe(false);
    expect((await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 }))!.can_edit).toBe(true);
    await expect(as(dev).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", set: { x: 9 } }] })).rejects.toThrow(/view and comment/);
    // Dev's agent session acts for Dev: refused too.
    await expect(t.mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_b", put: { kind: "sticky", x: 1 } }], ...agent })).rejects.toThrow(/view and comment/);
    await expect(as(dev).mutation(api.liveArtifacts.draftStart, { doc_id: doc })).rejects.toThrow(/view and comment/);
    // Comments stay open.
    await as(dev).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_v", put: { kind: "comment", text: "Looks good" } }] });
    // Named, Dev edits again.
    await as(rosa).mutation(api.liveArtifacts.setEditAccess, { doc_id: doc, edit: "owners", editors: [dev] });
    await as(dev).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", set: { x: 9 } }] });
    expect((await state(t, doc)).el_a).toMatchObject({ x: 9 });
  });

  test("comments carry their writer's identity, whatever the client claims", async () => {
    const { t, doc, rosa, as, agent } = await setup();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_1", put: { kind: "comment", text: "@agent lay this out", author_name: "Someone else" } }] });
    await t.mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_2", put: { kind: "comment", text: "Done", parent: "cm_1" } }], ...agent });
    const comments = await state(t, doc, "comments");
    expect(comments.cm_1).toMatchObject({ author_name: "Rosa", author: `u:${rosa}` });
    expect(comments.cm_2).toMatchObject({ author_name: "Lay out the timeline", parent: "cm_1" });
    await expect(as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_3", put: { kind: "sticky" } }] })).rejects.toThrow(/not a comment/);
  });

  // Regressions from the first independent review.
  test("a draft after a discard starts from main again (retired rows are absent)", async () => {
    const { t, doc, rosa, as } = await setup();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 0, text: "main" } }] });
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_a", set: { text: "d1" } }] });
    await as(rosa).mutation(api.liveArtifacts.draftDiscard, { doc_id: doc });
    const r = await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_a", set: { text: "d2" } }] });
    expect(r.keys).toEqual(["el_a"]);
    expect(await state(t, doc, "draft")).toEqual({ el_a: { kind: "sticky", x: 0, text: "d2" } });
  });

  test("a comment's author cannot be rewritten by a later edit", async () => {
    const { t, doc, rosa, dev, as } = await setup();
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_1", put: { kind: "comment", text: "hi" } }] });
    await as(dev).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_1", set: { author: `u:${dev}`, author_name: "Dev", resolved: true } }] });
    expect((await state(t, doc, "comments")).cm_1).toMatchObject({ author: `u:${rosa}`, author_name: "Rosa", resolved: true });
  });

  test("history at a revision inside a batch folds just that batch's prefix", async () => {
    const { doc, rosa, as } = await setup();
    const r = await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 1 } }, { k: "el_b", put: { kind: "sticky", x: 2 } }] });
    expect(r.rev).toBe(2);
    const mid = await as(rosa).action(api.liveArtifacts.stateAt, { doc_id: doc, rev: 1 });
    expect(mid.map((e: any) => e.key)).toEqual(["el_a"]);
  });

  test("a restore larger than one transaction lands in batches", async () => {
    const { t, doc, rosa, as } = await setup();
    const many = Array.from({ length: 900 }, (_, i) => ({ k: `el_${String(i).padStart(4, "0")}`, put: { kind: "sticky", x: i } }));
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_keep", put: { kind: "sticky", x: 0 } }] });
    const { rev } = await as(rosa).mutation(api.liveArtifacts.checkpoint, { doc_id: doc });
    for (let i = 0; i < many.length; i += 300) await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: many.slice(i, i + 300) });
    const r = await as(rosa).action(api.liveArtifacts.restore, { doc_id: doc, rev });
    expect(r.changed).toBe(900);
    const live = Object.entries(await state(t, doc)).filter(([, s]) => s !== "deleted").map(([k]) => k);
    expect(live).toEqual(["el_keep"]);
  });

  test("presence lists the live and sweeps the departed", async () => {
    const { t, doc, rosa, dev, as } = await setup();
    await t.run(async (ctx: any) => {
      for (let i = 0; i < 120; i++) await ctx.db.insert("live_presence", { doc_id: doc, actor: `u:${rosa}:old${i}`, kind: "person", user_id: rosa, name: "Old", color: "#000", updated_at: 1 });
    });
    await as(dev).mutation(api.livePresence.setPresence, { doc_id: doc, tab: "t1", position: { point: { x: 1, y: 2 } } });
    const people = await as(rosa).query(api.livePresence.presence, { doc_id: doc });
    expect(people!.map((p: any) => p.name)).toEqual(["Dev"]);
    const left = await t.run((ctx: any) => ctx.db.query("live_presence").collect());
    expect(left.length).toBeLessThan(121);
  });

  test("a shared link shows the saved layer only, and nothing for other tokens", async () => {
    const { t, doc, note, rosa, as } = await setup();
    await t.run(async (ctx: any) => { await ctx.db.patch(doc, { share_token: "tok_board" }); await ctx.db.patch(note, { share_token: "tok_note" }); });
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", x: 1 } }, { k: "el_gone", put: { kind: "sticky", x: 2 } }] });
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_gone", del: true }] });
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_secret", put: { kind: "sticky", x: 3 } }] });
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "comments", ops: [{ k: "cm_1", put: { kind: "comment", text: "internal" } }] });
    const shared = await t.query(api.liveArtifacts.sharedElements, { share_token: "tok_board" });
    expect(shared!.elements.map((e: any) => e.key)).toEqual(["el_a"]);
    expect(shared!.doc.title).toBe("Launch timeline");
    expect(await t.query(api.liveArtifacts.sharedElements, { share_token: "tok_note" })).toBeNull();
    expect(await t.query(api.liveArtifacts.sharedElements, { share_token: "nope" })).toBeNull();
  });

  test("a draft refuses to grow past what one save can close", async () => {
    const { doc, rosa, as } = await setup();
    const keys = (from: number) => Array.from({ length: 400 }, (_, i) => ({ k: `el_${from + i}`, put: { kind: "sticky", x: i } }));
    for (let i = 0; i < 1200; i += 400) await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: keys(i) });
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: keys(1200).slice(0, 300) });
    await expect(as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: keys(1500).slice(0, 1) })).rejects.toThrow(/at most 1500/);
    // Rewriting elements already in it is fine, and it still saves.
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_0", set: { x: 99 } }] });
    expect(await as(rosa).mutation(api.liveArtifacts.draftSave, { doc_id: doc })).toMatchObject({ saved: 1500 });
  });

  test("an element whose merged fields outgrow the limit in UTF-8 is refused", async () => {
    const { doc, rosa, as } = await setup();
    const wide = "汉".repeat(6000); // 18 KB in UTF-8, 6 K characters
    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", put: { kind: "sticky", a: wide } }] });
    await expect(as(rosa).mutation(api.liveArtifacts.apply, { doc_id: doc, ops: [{ k: "el_a", set: { b: wide } }] })).rejects.toThrow(/over/);
  });

  test("a late save or discard for a closed draft never touches the next one", async () => {
    const { t, doc, rosa, as, agent } = await setup();
    await t.mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_one", put: { kind: "sticky", x: 1 } }], ...agent });
    const first = (await as(rosa).query(api.liveArtifacts.elementsSince, { doc_id: doc, since: 0 }))!.draft!.at;
    expect(await as(rosa).mutation(api.liveArtifacts.draftSave, { doc_id: doc, draft_at: first })).toMatchObject({ saved: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await t.mutation(api.liveArtifacts.apply, { doc_id: doc, layer: "draft", ops: [{ k: "el_two", put: { kind: "sticky", x: 2 } }], ...agent });
    // The first save's retry arrives now.
    expect(await as(rosa).mutation(api.liveArtifacts.draftSave, { doc_id: doc, draft_at: first })).toMatchObject({ saved: 0, stale: true });
    expect(await as(rosa).mutation(api.liveArtifacts.draftDiscard, { doc_id: doc, draft_at: first })).toMatchObject({ discarded: 0, stale: true });
    expect(Object.keys(await state(t, doc))).toEqual(["el_one"]);
    expect(Object.keys(await state(t, doc, "draft"))).toEqual(["el_two"]);
  });
});
