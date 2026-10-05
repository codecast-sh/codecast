// A project's expectations (the-line-model.md LM5): the data path from a
// proposal to a version, the history every version keeps, who may read and
// change a project's document, and the card answer that applies a proposal.
import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { hashToken } from "./apiTokens";
import { brief, forProject, propose, resolve, show } from "./expectations";
import { settleExpectationCard } from "./lib/expectationsApply";

const INDEXES = schemaIndexes(schema);
const TEAM = "teams_union";
const OWNER = "users_owner";
const MATE = "users_mate";
const OUTSIDER = "users_out";
const QUOTED = { kind: "call", ref: "cl-96:718", quote: "the information should hold true", when: "2026-09-30" };
const BARE = { kind: "commit", ref: "um@0274603e1d" };

async function makeCtx(asUser: string | null = null) {
  let t = 1;
  let n = 0;
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Ashot" }, { _id: MATE, name: "Cam" }, { _id: OUTSIDER, name: "Out" }],
    api_tokens: await Promise.all([OWNER, MATE, OUTSIDER].map(async (u) => ({ _id: `api_tokens_${u}`, user_id: u, token_hash: await hashToken(`tok-${u}`) }))),
    teams: [{ _id: TEAM, name: "Union" }],
    team_memberships: [{ _id: "tm_1", user_id: OWNER, team_id: TEAM, role: "admin" }, { _id: "tm_2", user_id: MATE, team_id: TEAM, role: "member" }],
    projects: [{ _id: "projects_calls", user_id: OWNER, team_id: TEAM, workspace: `team:${TEAM}`, title: "Callers & Call Management", status: "active", created_at: 1, updated_at: 1 }],
    project_expectations: [],
    expectation_proposals: [],
    counters: [],
    session_decisions: [],
  };
  const db = makeFakeDb(tables, { indexes: INDEXES, creationTime: () => t++, mintId: (table) => `${table}_${++n}`, strictPatch: true });
  return { auth: { async getUserIdentity() { return asUser ? { subject: asUser } : null; } }, db } as any;
}

const scope = (user = OWNER) => ({ api_token: `tok-${user}`, workspace: "team" as const, team_id: TEAM, project: "Callers" });
const run = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

describe("expectations data path", () => {
  test("well-cited additions apply on their own as version 1, with stable ids and the window as the cursor", async () => {
    const ctx = await makeCtx();
    const out = await run(propose, ctx, { ...scope(), summary: "Seed", until: 500, ops: [
      { op: "add", part: "Calls", text: "A call card's facts are true.", citations: [QUOTED, BARE] },
      { op: "add", part: "Calls", text: "A callback happens when the contact asked.", citations: [QUOTED] },
    ] });
    expect(out).toEqual({ short_id: "xp-1", status: "applied", version: 1, auto: true });
    const s = await run(show, ctx, scope());
    expect(s.current_version).toBe(1);
    expect(s.doc.items.map((e: any) => e.id)).toEqual(["ex-callers-call-1", "ex-callers-call-2"]);
    expect(s.doc).toMatchObject({ how: "auto", applied_by: "Ashot", proposal: "xp-1", prefix: "callers-call" });
    expect(s.cursor).toBe(500);
    const row = await ctx.db.query("project_expectations").first();
    expect(row.workspace).toBe(`team:${TEAM}`);
  });

  test("an edit waits for a person; applying writes version 2 and version 1 stays readable", async () => {
    const ctx = await makeCtx();
    await run(propose, ctx, { ...scope(), summary: "Seed", ops: [{ op: "add", part: "Calls", text: "A call card's facts are true.", citations: [QUOTED] }] });
    const edit = await run(propose, ctx, { ...scope(), summary: "Sharpen", ops: [{ op: "edit", id: "ex-callers-call-1", text: "A call card's facts are true, in English.", citations: [BARE] }] });
    expect(edit).toEqual({ short_id: "xp-2", status: "open", version: 1 });
    expect((await run(show, ctx, scope())).proposals[0]).toMatchObject({ short_id: "xp-2", status: "open", changes: 1 });

    const applied = await run(resolve, ctx, { api_token: `tok-${MATE}`, proposal: "xp-2", action: "apply" });
    expect(applied).toEqual({ short_id: "xp-2", status: "applied", version: 2 });
    const now = await run(show, ctx, scope());
    expect(now.doc.items[0]).toMatchObject({ id: "ex-callers-call-1", text: "A call card's facts are true, in English.", added_in: 1, changed_in: 2 });
    expect(now.doc).toMatchObject({ version: 2, how: "person", applied_by: "Cam" });
    expect(now.versions.map((v: any) => v.version)).toEqual([2, 1]);
    const old = await run(show, ctx, { ...scope(), version: 1 });
    expect(old.doc.items[0].text).toBe("A call card's facts are true.");

    const judge = await run(brief, ctx, scope(MATE));
    expect(judge.version).toBe(2);
    expect(judge.text).toContain("ex-callers-call-1: A call card's facts are true, in English.");
    expect((await run(brief, ctx, { ...scope(), version: 1 })).text).toContain("version 1");
  });

  test("a proposal that cannot apply is refused whole and stores nothing", async () => {
    const ctx = await makeCtx();
    await expect(run(propose, ctx, { ...scope(), summary: "x", ops: [{ op: "retire", id: "ex-callers-call-4", reason: "gone", citations: [BARE] }] })).rejects.toThrow(/no such expectation/);
    await expect(run(propose, ctx, { ...scope(), summary: "x", ops: [{ op: "add", part: "Calls", text: "T.", citations: [] }] })).rejects.toThrow(/at least one source/);
    expect(await ctx.db.query("expectation_proposals").collect()).toEqual([]);
  });

  test("a line changed under an open proposal refuses it, and the proposal says why", async () => {
    const ctx = await makeCtx();
    await run(propose, ctx, { ...scope(), summary: "Seed", ops: [{ op: "add", part: "Calls", text: "A card's facts are true.", citations: [QUOTED] }] });
    await run(propose, ctx, { ...scope(), summary: "A", ops: [{ op: "edit", id: "ex-callers-call-1", note: "under review", citations: [BARE] }] });
    await run(propose, ctx, { ...scope(), summary: "B", ops: [{ op: "retire", id: "ex-callers-call-1", reason: "ruled out", citations: [BARE] }] });
    await run(resolve, ctx, { api_token: `tok-${OWNER}`, proposal: "xp-2", action: "apply" });
    await expect(run(resolve, ctx, { api_token: `tok-${OWNER}`, proposal: "xp-3", action: "apply" })).rejects.toThrow(/changed in version 2/);
    const s = await run(show, ctx, scope());
    expect(s.proposals.find((p: any) => p.short_id === "xp-3")).toMatchObject({ status: "open", refused: expect.stringContaining("changed in version 2") });
    expect(s.current_version).toBe(2);
  });

  test("an empty harvest records its window and changes nothing", async () => {
    const ctx = await makeCtx();
    expect(await run(propose, ctx, { ...scope(), summary: "Nothing new", since: 10, until: 900, ops: [] })).toEqual({ short_id: "xp-1", status: "empty", version: 0 });
    const s = await run(show, ctx, scope());
    expect(s).toMatchObject({ current_version: 0, doc: null, cursor: 900 });
    expect((await run(brief, ctx, scope())).text).toBe("Callers & Call Management has no expectations yet.\n");
  });
});

describe("who may read and change a project's expectations", () => {
  test("someone outside the project's workspace reads nothing and resolves nothing", async () => {
    const ctx = await makeCtx();
    await run(propose, ctx, { ...scope(), summary: "Seed", ops: [{ op: "add", part: "Calls", text: "T one.", citations: [QUOTED] }, { op: "add", part: "Calls", text: "T two.", citations: [BARE] }] });
    await expect(run(show, ctx, scope(OUTSIDER))).rejects.toThrow();
    await expect(run(brief, ctx, { ...scope(OUTSIDER), workspace: "personal", team_id: undefined })).rejects.toThrow(/No project matching/);
    await expect(run(resolve, ctx, { api_token: `tok-${OUTSIDER}`, proposal: "xp-1", action: "apply" })).rejects.toThrow(/not found/);
    expect(await run(forProject, await makeCtx(OUTSIDER), { project_id: "projects_calls" })).toBeNull();
  });

  test("an agent session proposes but never applies or drops", async () => {
    const ctx = await makeCtx();
    await run(propose, ctx, { ...scope(), summary: "Seed", ops: [{ op: "add", part: "Calls", text: "T one.", citations: [BARE] }] });
    await expect(run(resolve, ctx, { api_token: `tok-${OWNER}`, proposal: "xp-1", action: "apply", conversation_id: "jx7abcd" })).rejects.toThrow(/a person's act/);
    expect((await run(show, ctx, scope())).proposals[0].status).toBe("open");
  });

  test("the Line tab reads the same document for a signed-in teammate", async () => {
    const ctx = await makeCtx(MATE);
    await run(propose, ctx, { ...scope(), summary: "Seed", ops: [{ op: "add", part: "Calls", text: "T one.", citations: [QUOTED] }] });
    const tab = await run(forProject, ctx, { project_id: "projects_calls" });
    expect(tab).toMatchObject({ current_version: 1, project: { title: "Callers & Call Management" } });
    expect(tab.doc.items).toHaveLength(1);
  });
});

describe("the card's answer", () => {
  async function withCard(ctx: any) {
    await run(propose, ctx, { ...scope(), summary: "Seed", ops: [{ op: "add", part: "Calls", text: "T one.", citations: [QUOTED] }] });
    await run(propose, ctx, { ...scope(), summary: "Retire", ops: [{ op: "retire", id: "ex-callers-call-1", reason: "ruled out", citations: [BARE] }] });
    const proposal = await ctx.db.query("expectation_proposals").withIndex("by_short_id", (q: any) => q.eq("short_id", "xp-2")).first();
    await ctx.db.patch(proposal._id, { decision_id: "session_decisions_card" });
    return { _id: "session_decisions_card" } as any;
  }
  const person = { kind: "user", id: MATE, user_id: MATE } as any;

  test("Apply from a person lands the proposal as the next version", async () => {
    const ctx = await makeCtx();
    const row = await withCard(ctx);
    await settleExpectationCard(ctx, row, { status: "answered", answer_index: 0 }, person, 5);
    const s = await run(show, ctx, scope());
    expect(s.doc).toMatchObject({ version: 2, how: "person", applied_by: "Cam" });
    expect(s.doc.items[0]).toMatchObject({ status: "retired", retired_reason: "ruled out" });
  });

  test("Drop or a dismissal closes it; a role's answer or a withdrawal leaves it open", async () => {
    for (const [verdict, by, status] of [
      [{ status: "answered", answer_index: 1 }, person, "dropped"],
      [{ status: "dismissed" }, person, "dropped"],
      [{ status: "answered", answer_index: 0 }, { kind: "role", id: "org_roles_1" }, "open"],
      [{ status: "withdrawn" }, person, "open"],
    ] as const) {
      const ctx = await makeCtx();
      const row = await withCard(ctx);
      await settleExpectationCard(ctx, row, verdict as any, by as any, 5);
      expect((await run(show, ctx, scope())).proposals.find((p: any) => p.short_id === "xp-2").status).toBe(status);
    }
  });
});
