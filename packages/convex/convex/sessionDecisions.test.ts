import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  askCore,
  answerCore,
  recommendCore,
  grantCore,
  listForUserCore,
  agreementHistory,
  finalizeAnswer,
  buildLadder,
  normalizeVerdict,
  answerLabel,
  GRANT_TTL_MS,
} from "./sessionDecisions";
import { assignCategory, pinnedCategory } from "./lib/decisionCategory";
import { createStackCore, addToStackCore, applyAutoDefaultsCore, delegateStack } from "./decisionStacks";

// The W2 contract (docs/architecture/decisions-as-documents.md): category
// pinning, inbox materialization, the ladder, a role answering under a grant,
// a person's answer winning the race, stack auto defaults, and override
// revocation. Driven through the exported core functions against the fake db.

const HOST = "users_host" as any; // hosts the roles, owns the asking session
const BOSS = "users_boss" as any; // the person the role chain reports to
const OWNER2 = "users_owner2" as any; // a second session owner
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function seed(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: HOST, name: "Host" },
      { _id: BOSS, name: "Boss" },
      { _id: OWNER2, name: "Owner Two" },
    ],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin" },
      { _id: "m2", user_id: BOSS, team_id: TEAM, role: "admin" },
    ],
    org_roles: [
      {
        _id: "org_roles_lead",
        short_id: "or-1",
        scope_type: "team",
        team_id: TEAM,
        host_user_id: HOST,
        name: "Growth lead",
        handle: "growth",
        scope: { project_ids: ["projects_p1"], plan_ids: [] },
        reports_to: { kind: "role", role_id: "org_roles_head" },
        status: "active",
        created_by: HOST,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        _id: "org_roles_paused",
        short_id: "or-2",
        scope_type: "team",
        team_id: TEAM,
        host_user_id: HOST,
        name: "Paused seat",
        handle: "paused",
        scope: { project_ids: [], plan_ids: [] },
        reports_to: { kind: "role", role_id: "org_roles_lead" },
        status: "paused",
        created_by: HOST,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        _id: "org_roles_head",
        short_id: "or-3",
        scope_type: "team",
        team_id: TEAM,
        host_user_id: HOST,
        name: "Head",
        handle: "head",
        scope: { project_ids: [], plan_ids: [] },
        reports_to: { kind: "user", user_id: BOSS },
        status: "active",
        created_by: HOST,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    conversations: [
      // The asking session reports to the growth lead.
      { _id: "conversations_ask", session_id: "sess-ask", user_id: HOST, team_id: TEAM, message_count: 10, org_role_id: "org_roles_lead" },
      // The growth lead's own standing session.
      { _id: "conversations_lead", session_id: "sess-lead", user_id: HOST, team_id: TEAM, message_count: 3, org_role_id: "org_roles_lead" },
      // A second asker under the same role (the "2 askers" rule).
      { _id: "conversations_ask2", session_id: "sess-ask2", user_id: HOST, team_id: TEAM, message_count: 4, org_role_id: "org_roles_lead" },
      // A session with no role at all.
      { _id: "conversations_plain", session_id: "sess-plain", user_id: HOST, message_count: 1 },
    ],
    session_owners: [{ _id: "so1", conversation_id: "conversations_ask", user_id: OWNER2, added_by: HOST, added_at: NOW }],
    tasks: [{ _id: "tasks_t1", short_id: "ct-7", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, title: "Ship the thing", status: "in_review", project_id: "projects_p1", task_type: "task", priority: "medium" }],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
    decision_stacks: [],
    docs: [],
    counters: [],
    pending_messages: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  return { ctx: { db } as any, tables, db };
}

const twoOptions = [
  { label: "Keep vendored", description: "no change" },
  { label: "Switch to upstream", description: "one afternoon of work" },
];

async function askApproach(ctx: any, session = "sess-ask", question = "Keep the engine vendored?") {
  return askCore(ctx, { userId: HOST }, {
    session_id: session,
    question,
    options: twoOptions,
    context_md: "Reasoning goes here.",
    category: "approach",
  });
}

describe("category assignment", () => {
  test("an option naming a deploy to production pins the protected category", () => {
    const { category, pinned } = assignCategory(
      { question: "How do we ship the fix?", options: [{ label: "Deploy to production now" }, { label: "Wait for the batch" }] },
      "approach",
    );
    expect(category).toBe("production");
    expect(pinned).toBe(true);
  });

  test("an open proposal stands when nothing pins", () => {
    expect(assignCategory({ question: "Which parser?", options: twoOptions }, "approach")).toEqual({ category: "approach", pinned: false });
  });

  test("no proposal and nothing pinned is unknown (human held)", () => {
    expect(assignCategory({ question: "Which parser?", options: twoOptions }, undefined).category).toBe("unknown");
  });

  test("a proposal outside the vocabulary is ignored", () => {
    expect(assignCategory({ question: "Which parser?", options: twoOptions }, "whatever").category).toBe("unknown");
  });

  test("deletion, purchase, access and external messages each pin their category", () => {
    expect(pinnedCategory({ question: "Clean up?", options: [{ label: "Delete the old rows" }, { label: "Keep" }] })).toBe("data");
    expect(pinnedCategory({ question: "Tooling?", options: [{ label: "Buy the pro plan" }, { label: "Stay free" }] })).toBe("billing");
    expect(pinnedCategory({ question: "Onboarding?", options: [{ label: "Grant access to the repo" }, { label: "Wait" }] })).toBe("access");
    expect(pinnedCategory({ question: "Customer?", options: [{ label: "Send the email today" }, { label: "Hold" }] })).toBe("external");
    expect(pinnedCategory({ question: "Cap?", options: [{ label: "Raise the limit to 500" }, { label: "Keep 100" }] })).toBe("limit");
  });
});

describe("ask: people, inbox, ladder, holder", () => {
  test("materializes one inbox row per person and records the ladder up to the first person", async () => {
    const { ctx, tables } = seed();
    const r = await askApproach(ctx);
    expect(r.error).toBeUndefined();
    expect(r.short_id).toBe("sd-1");
    expect(r.category).toBe("approach");
    const row = tables.session_decisions[0];
    // People: the primary owner, the second owner, and the boss above the chain.
    expect(new Set(row.asked_user_ids)).toEqual(new Set([HOST, OWNER2, BOSS]));
    expect(tables.decision_inbox.map((i) => [i.user_id, i.status])).toEqual([
      [HOST, "pending"],
      [OWNER2, "pending"],
      [BOSS, "pending"],
    ]);
    // Ladder: lead then head, both active, none skipped.
    expect(row.hops.map((h: any) => h.role_id)).toEqual(["org_roles_lead", "org_roles_head"]);
    expect(row.hops.every((h: any) => !h.note)).toBe(true);
    // No grant: the people hold it.
    expect(row.holder).toEqual({ kind: "user", id: HOST });
    expect(row.holder_key).toBe(`user:${HOST}`);
    expect(row.scope_keys).toEqual(["role:org_roles_lead", "project:projects_p1"]);
  });

  test("a paused role on the chain is recorded as a skipped hop", async () => {
    const { ctx } = seed();
    const paused = await ctx.db.get("org_roles_paused");
    const ladder = await buildLadder(ctx, paused, NOW);
    expect(ladder.hops.map((h: any) => [h.role_id, h.note])).toEqual([
      ["org_roles_paused", "skipped: paused"],
      ["org_roles_lead", undefined],
      ["org_roles_head", undefined],
    ]);
    expect(ladder.firstPersonId).toBe(BOSS);
    expect(ladder.activeRoles.map((r) => String(r._id))).toEqual(["org_roles_lead", "org_roles_head"]);
  });

  test("a session with no role asks only its owners", async () => {
    const { ctx, tables } = seed();
    const r = await askApproach(ctx, "sess-plain");
    expect(r.error).toBeUndefined();
    const row = tables.session_decisions[0];
    expect(row.asked_user_ids).toEqual([HOST]);
    expect(row.hops).toEqual([]);
  });

  test("binds to a task (default station = the task's status) and creates a decision doc", async () => {
    const { ctx, tables } = seed();
    const r = await askCore(ctx, { userId: HOST }, {
      session_id: "sess-ask",
      question: "Which schema wins?",
      options: twoOptions,
      context_md: "ctx",
      category: "approach",
      task: "ct-7",
      doc_md: "# Long body\n\nwhy",
    });
    expect(r.error).toBeUndefined();
    const row = tables.session_decisions[0];
    expect(row.task_id).toBe("tasks_t1");
    expect(row.station).toBe("in_review");
    expect(tables.docs).toHaveLength(1);
    expect(tables.docs[0].doc_type).toBe("decision");
    expect(row.doc_id).toBe(tables.docs[0]._id);
    expect(row.scope_keys).toContain("project:projects_p1");
  });

  test("listForUser reads the inbox and falls back to the owner index for legacy rows", async () => {
    const { ctx, tables } = seed({
      session_decisions: [
        { _id: "session_decisions_legacy", conversation_id: "conversations_plain", session_id: "sess-plain", user_id: BOSS, question: "old", options: twoOptions, blocking: true, status: "pending", created_at: NOW - 1000 },
      ],
    });
    await askApproach(ctx);
    const fresh = tables.session_decisions.find((r) => r._id !== "session_decisions_legacy")!._id;
    const forBoss = await listForUserCore(ctx, BOSS, NOW);
    expect(forBoss.map((r) => r._id).sort()).toEqual([fresh, "session_decisions_legacy"].sort());
    const forOwner2 = await listForUserCore(ctx, OWNER2, NOW);
    expect(forOwner2.map((r) => r._id)).toEqual([fresh]);
  });
});

describe("the race", () => {
  test("a role on the ladder recommends; a role off the ladder cannot", async () => {
    const { ctx, tables } = seed();
    await askApproach(ctx);
    const r = await recommendCore(ctx, { userId: HOST }, { decision_id: "sd-1", session_id: "sess-lead", recommendation: 1, note: "cheaper" });
    expect(r.error).toBeUndefined();
    expect(tables.session_decisions[0].hops[0]).toMatchObject({ role_id: "org_roles_lead", recommendation: 1, note: "cheaper" });
    const off = await recommendCore(ctx, { userId: HOST }, { decision_id: "sd-1", session_id: "sess-plain", recommendation: 0 });
    expect(off.error).toContain("no role");
  });

  test("a role answers under a grant and the answer is delivered to the asking session", async () => {
    const { ctx, tables } = seed({
      decision_grants: [
        { _id: "decision_grants_g1", role_id: "org_roles_lead", category: "approach", scope_key: "role:org_roles_lead", granted_by: BOSS, granted_at: NOW, expires_at: Date.now() + GRANT_TTL_MS },
      ],
    });
    const asked = await askApproach(ctx);
    const decisionId = asked.id;
    expect(asked.holder).toEqual({ kind: "role", id: "org_roles_lead" });
    expect(asked.grant_id).toBe("decision_grants_g1");
    const r = await answerCore(ctx, { userId: HOST }, { decision_id: "sd-1", session_id: "sess-lead", answer_index: 1 });
    expect(r.error).toBeUndefined();
    expect(r.answered_by).toEqual({ kind: "role", id: "org_roles_lead" });
    const row = tables.session_decisions[0];
    expect(row.status).toBe("answered");
    expect(row.answer_index).toBe(1);
    expect(row.grant_id).toBe("decision_grants_g1");
    expect(tables.decision_inbox.every((i) => i.status === "done")).toBe(true);
    // Delivered as the "Decision: …" user message into the ASKING conversation.
    const msg = tables.pending_messages.find((m) => m.conversation_id === "conversations_ask");
    expect(msg?.content).toContain("Decision: Switch to upstream");
    expect(msg?.content).toContain(`<cast-decision id="${decisionId}"`);
  });

  test("without a grant the role's session cannot answer", async () => {
    const { ctx } = seed();
    await askApproach(ctx);
    // The lead's host is a person in asked_user_ids, so answering from the
    // lead's session with no grant falls through to a HUMAN answer by HOST.
    const r = await answerCore(ctx, { userId: HOST }, { decision_id: "sd-1", session_id: "sess-lead", answer_index: 0 });
    expect(r.answered_by).toEqual({ kind: "user", id: HOST });
    // A stranger is refused outright.
    const { ctx: ctx2 } = seed();
    await askApproach(ctx2);
    const s = await answerCore(ctx2, { userId: "users_stranger" as any }, { decision_id: "sd-1", answer_index: 0 });
    expect(s.error).toContain("Not a holder");
  });

  test("a person's answer wins the race: the second writer sees already_resolved", async () => {
    const { ctx, tables } = seed({
      decision_grants: [
        { _id: "decision_grants_g1", role_id: "org_roles_lead", category: "approach", scope_key: "role:org_roles_lead", granted_by: BOSS, granted_at: NOW, expires_at: Date.now() + GRANT_TTL_MS },
      ],
    });
    await askApproach(ctx);
    const human = await answerCore(ctx, { userId: BOSS }, { decision_id: "sd-1", answer_index: 0 });
    expect(human.already_resolved).toBe(false);
    expect(human.answered_by).toEqual({ kind: "user", id: BOSS });
    const role = await answerCore(ctx, { userId: HOST }, { decision_id: "sd-1", session_id: "sess-lead", answer_index: 1 });
    expect(role.error).toContain("already answered");
    expect(tables.session_decisions[0].answer_index).toBe(0);
    expect(tables.pending_messages).toHaveLength(1);
  });

  test("a protected category never resolves to a role, even with a grant row", async () => {
    const { ctx, tables } = seed({
      decision_grants: [
        { _id: "decision_grants_g1", role_id: "org_roles_lead", category: "production", scope_key: "role:org_roles_lead", granted_by: BOSS, granted_at: NOW, expires_at: Date.now() + GRANT_TTL_MS },
      ],
    });
    const r = await askCore(ctx, { userId: HOST }, {
      session_id: "sess-ask",
      question: "Ship it?",
      options: [{ label: "Deploy to production" }, { label: "Wait" }],
      context_md: "ctx",
      category: "approach",
    });
    expect(r.category).toBe("production");
    expect(tables.session_decisions[0].holder.kind).toBe("user");
  });
});

describe("grants", () => {
  // Three answered decisions of one category in one scope where the lead's
  // recommendation was picked, from two different askers.
  async function earn(ctx: any) {
    for (const [i, session] of ["sess-ask", "sess-ask2", "sess-ask"].entries()) {
      const a = await askApproach(ctx, session, `Question ${i}`);
      await recommendCore(ctx, { userId: HOST }, { decision_id: a.short_id, session_id: "sess-lead", recommendation: 1 });
      await answerCore(ctx, { userId: BOSS }, { decision_id: a.short_id, answer_index: 1 });
    }
  }

  test("agreement history counts agreements and distinct askers", async () => {
    const { ctx } = seed();
    await earn(ctx);
    const h = await agreementHistory(ctx, "org_roles_lead" as any, "approach", "role:org_roles_lead", Date.now());
    expect(h).toEqual({ agreements: 3, askers: 2, eligible: true });
    const other = await agreementHistory(ctx, "org_roles_head" as any, "approach", "role:org_roles_lead", Date.now());
    expect(other.eligible).toBe(false);
  });

  test("grant refuses until earned unless forced; once granted, new asks are held by the role", async () => {
    const { ctx, tables } = seed();
    const early = await grantCore(ctx, BOSS, { role_id: "org_roles_lead" as any, category: "approach", scope_key: "role:org_roles_lead" });
    expect(early.error).toContain("Not earned yet");
    await earn(ctx);
    const g = await grantCore(ctx, BOSS, { role_id: "org_roles_lead" as any, category: "approach", scope_key: "role:org_roles_lead" });
    expect(g.error).toBeUndefined();
    expect(g.forced).toBe(false);
    const next = await askApproach(ctx, "sess-ask", "A fourth question");
    expect(next.holder).toEqual({ kind: "role", id: "org_roles_lead" });
    expect(tables.decision_grants).toHaveLength(1);
  });

  test("a human only category cannot be granted", async () => {
    const { ctx } = seed();
    const r = await grantCore(ctx, BOSS, { role_id: "org_roles_lead" as any, category: "billing", scope_key: "role:org_roles_lead", force: true });
    expect(r.error).toContain("always held by a person");
  });

  test("two consecutive overrides revoke the grant", async () => {
    const grant = { _id: "decision_grants_g1", role_id: "org_roles_lead", category: "approach", scope_key: "role:org_roles_lead", granted_by: BOSS, granted_at: NOW, expires_at: Date.now() + GRANT_TTL_MS, override_streak: 0 };
    const { ctx, tables } = seed({ decision_grants: [grant] });
    // Two reopened rows (a person reopened what the role answered with option 1).
    for (const n of [1, 2]) {
      const a = await askApproach(ctx, "sess-ask", `Reopened ${n}`);
      await ctx.db.patch(a.id, { reopened_from: { grant_id: "decision_grants_g1", answer_index: 1, at: NOW }, holder: { kind: "user", id: BOSS }, holder_key: `user:${BOSS}` });
    }
    const first = tables.session_decisions[0];
    await finalizeAnswer(ctx, first, { status: "answered", answer_index: 0 }, { kind: "user", id: BOSS, user_id: BOSS }, { deliver: false, now: NOW });
    expect(tables.decision_grants[0].override_streak).toBe(1);
    expect(tables.decision_grants[0].revoked_at).toBeUndefined();
    const second = tables.session_decisions[1];
    await finalizeAnswer(ctx, second, { status: "answered", answer_index: 0 }, { kind: "user", id: BOSS, user_id: BOSS }, { deliver: false, now: NOW });
    expect(tables.decision_grants[0].revoked_at).toBe(NOW);
    expect(tables.decision_grants[0].revoked_reason).toContain("overridden 2 times");
  });

  test("an agreement after an override resets the streak", async () => {
    const grant = { _id: "decision_grants_g1", role_id: "org_roles_lead", category: "approach", scope_key: "role:org_roles_lead", granted_by: BOSS, granted_at: NOW, expires_at: Date.now() + GRANT_TTL_MS, override_streak: 1 };
    const { ctx, tables } = seed({ decision_grants: [grant] });
    const a = await askApproach(ctx);
    await ctx.db.patch(a.id, { reopened_from: { grant_id: "decision_grants_g1", answer_index: 1, at: NOW } });
    await finalizeAnswer(ctx, tables.session_decisions[0], { status: "answered", answer_index: 1 }, { kind: "user", id: BOSS, user_id: BOSS }, { deliver: false, now: NOW });
    expect(tables.decision_grants[0].override_streak).toBe(0);
  });
});

describe("stacks", () => {
  test("create, append via ask --stack, and auto default the advisory members after the deadline", async () => {
    const { ctx, tables } = seed();
    const s = await createStackCore(ctx, HOST, { title: "Launch checklist", session_id: "sess-ask", policy: { auto_default_after_ms: 60_000 } });
    expect(s.short_id).toBe("ds-1");
    expect(tables.decision_stacks[0].team_id).toBe(TEAM);
    const advisory = await askCore(ctx, { userId: HOST }, {
      session_id: "sess-ask",
      question: "Advisory one",
      options: twoOptions,
      context_md: "ctx",
      category: "approach",
      blocking: false,
      default_option: 1,
      stack: "ds-1",
    });
    const blocking = await askCore(ctx, { userId: HOST }, {
      session_id: "sess-ask",
      question: "Blocking one",
      options: twoOptions,
      context_md: "ctx",
      category: "approach",
      stack: "ds-1",
    });
    expect(tables.decision_stacks[0].decision_ids).toEqual([advisory.id, blocking.id]);
    expect(tables.session_decisions[0].scope_keys).toContain(`stack:${s.id}`);

    // Before the deadline nothing happens.
    const created = tables.session_decisions[0].created_at;
    expect((await applyAutoDefaultsCore(ctx, created + 10_000)).answered).toBe(0);
    // After it, the advisory member answers with its default; the blocking one never does.
    expect((await applyAutoDefaultsCore(ctx, created + 61_000)).answered).toBe(1);
    expect(tables.session_decisions[0]).toMatchObject({ status: "answered", answer_index: 1, answered_by: { kind: "policy", id: `stack:${s.id}` } });
    expect(tables.session_decisions[1].status).toBe("pending");
    expect(tables.decision_stacks[0].status).toBe("open");
    expect(tables.pending_messages.some((m) => m.content.includes("Decision: Switch to upstream"))).toBe(true);

    // Resolving the last member closes the stack.
    await answerCore(ctx, { userId: BOSS }, { decision_id: blocking.short_id, answer_index: 0 });
    expect(tables.decision_stacks[0].status).toBe("done");
  });

  test("addToStack moves an existing decision in and re-resolves its holder", async () => {
    const { ctx, tables } = seed();
    const a = await askApproach(ctx);
    const s = await createStackCore(ctx, HOST, { title: "S" });
    const r = await addToStackCore(ctx, HOST, s.short_id, a.short_id);
    expect((r as any).error).toBeUndefined();
    expect(tables.decision_stacks[0].decision_ids).toEqual([a.id]);
    expect(tables.session_decisions[0].stack_id).toBe(s.id);
  });

  test("delegating a stack grants the role every open category and hands it the pending members", async () => {
    const { ctx, tables } = seed();
    const s = await createStackCore(ctx, HOST, { title: "S", session_id: "sess-ask" });
    await askCore(ctx, { userId: HOST }, { session_id: "sess-ask", question: "Q1", options: twoOptions, context_md: "ctx", category: "scope", stack: s.short_id });
    const d = await delegateStack(ctx, HOST, tables.decision_stacks[0], "org_roles_lead" as any, NOW);
    expect(d.grants_created).toBe(6);
    expect(tables.decision_grants.every((g) => g.scope_key === `stack:${s.id}`)).toBe(true);
    expect(tables.session_decisions[0].holder).toEqual({ kind: "role", id: "org_roles_lead" });
    // A protected member stays with the people.
    await askCore(ctx, { userId: HOST }, { session_id: "sess-ask", question: "Q2", options: [{ label: "Delete the table" }, { label: "Keep" }], context_md: "ctx", stack: s.short_id });
    expect(tables.session_decisions[1].holder.kind).toBe("user");
  });
});

describe("answer kinds", () => {
  const base = { _id: "x", options: [{ label: "A" }, { label: "B" }, { label: "C" }], status: "pending" } as any;
  test("multi and rank validate lists; form validates fields", () => {
    expect(normalizeVerdict({ ...base, kind: "multi" }, { status: "answered", answer_json: [0, 2] })).toEqual({ status: "answered", answer_json: [0, 2], answer_index: 0, answer_text: undefined });
    expect(normalizeVerdict({ ...base, kind: "rank" }, { status: "answered", answer_json: [1, 1] })).toEqual({ error: "an option index repeats" });
    expect(normalizeVerdict({ ...base, kind: "single" }, { status: "answered", answer_index: 5 })).toEqual({ error: "answer_index out of range" });
    const form = { ...base, kind: "form", form: { fields: [{ key: "env", label: "Env", type: "select", options: ["dev", "prod"] }] } };
    expect(normalizeVerdict(form, { status: "answered", answer_json: { env: "staging" } })).toEqual({ error: "form field env must be one of: dev, prod" });
    expect(normalizeVerdict(form, { status: "answered", answer_json: { env: "prod" } })).toEqual({ status: "answered", answer_json: { env: "prod" }, answer_text: undefined });
  });
  test("the delivered line renders per kind", () => {
    expect(answerLabel({ kind: "multi", options: base.options }, { status: "answered", answer_json: [0, 2] })).toBe("A, C");
    expect(answerLabel({ kind: "rank", options: base.options }, { status: "answered", answer_json: [2, 0] })).toBe("C > A");
    expect(answerLabel({ kind: "form", options: [] }, { status: "answered", answer_json: { env: "prod", n: 3 } })).toBe("env=prod; n=3");
  });
});
