// Permanent deletion for regulated teams under convex-test. Every plan node
// gets a row generated from the schema's own validators, so "every covered
// table" is checked against the plans themselves, not a hand-kept list.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { artifactPlan, callPlan, conversationRowPlan, LEFT_OUT, teamDeletionSteps } from "./lib/deletionPlans";
import type { PurgeNode } from "./lib/purgeTree";
import { DELETION_PASS_BUDGET } from "./regulatedDeletion";

setDefaultTimeout(240_000);

const tables = (schema as any).tables as Record<string, any>;

// ── Rows from the schema ──────────────────────────────────────────────────

/** A value the validator accepts; referenced rows are made once per table. */
async function valueFor(ctx: any, val: any, made: Map<string, any>, depth: number): Promise<unknown> {
  switch (val.kind) {
    case "string": return "x";
    case "float64": case "number": return 1;
    case "int64": case "bigint": return 1n;
    case "boolean": return false;
    case "null": return null;
    case "any": return {};
    case "bytes": return new ArrayBuffer(1);
    case "literal": return val.value;
    case "union": return valueFor(ctx, val.members[0], made, depth);
    case "array": return [];
    case "record": return {};
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, f] of Object.entries<any>(val.fields)) if (f.isOptional !== "optional") out[k] = await valueFor(ctx, f, made, depth);
      return out;
    }
    case "id": {
      if (val.tableName === "_storage") return ctx.storage.store(new Blob(["x"]));
      if (!made.has(val.tableName)) {
        if (depth > 4) throw new Error(`reference chain too deep at ${val.tableName}`);
        made.set(val.tableName, await row(ctx, val.tableName, {}, made, depth + 1));
      }
      return made.get(val.tableName);
    }
    default: throw new Error(`no fixture for validator kind ${val.kind}`);
  }
}

/** A valid row of `table`: every required field filled, `fields` on top. */
async function row(ctx: any, table: string, fields: Record<string, unknown>, made: Map<string, any>, depth = 0): Promise<any> {
  const doc: Record<string, unknown> = {};
  for (const [k, f] of Object.entries<any>(tables[table].validator.fields)) {
    if (k in fields) doc[k] = fields[k];
    else if (f.isOptional !== "optional") doc[k] = await valueFor(ctx, f, made, depth);
  }
  return ctx.db.insert(table, doc);
}

type Seeded = { table: string; id: string };

/** One row for every node of `nodes` under `parent`, and their children's under each. */
async function seedTree(ctx: any, nodes: ReadonlyArray<PurgeNode>, parent: any, made: Map<string, any>, out: Seeded[]): Promise<void> {
  for (const node of nodes) {
    const value = node.value(parent);
    if (value === undefined || value === null) continue;
    const id = await row(ctx, node.table, { [node.field]: value }, made);
    out.push({ table: node.table, id: String(id) });
    if (node.children) await seedTree(ctx, node.children, await ctx.db.get(id), made, out);
  }
}

const left = (t: any, seeded: Seeded[]) =>
  t.run(async (ctx: any) => {
    const alive: string[] = [];
    for (const s of seeded) if (await ctx.db.get(s.id)) alive.push(s.table);
    return alive;
  });

// ── World ─────────────────────────────────────────────────────────────────

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = (name: string) => ctx.db.insert("users", { name, email: `${name.toLowerCase()}@x.dev` } as any);
    const admin = await user("Ada");
    const member = await user("Mo");
    const adminB = await user("Bea");
    const plainAdmin = await user("Cy");
    const plainMember = await user("Di");
    const team = (name: string, regulated: boolean) =>
      ctx.db.insert("teams", { name, invite_code: name.toUpperCase(), created_at: 1, ...(regulated ? { policy: { regulated_data: true } } : {}) } as any);
    const teamA = await team("Acme Health", true);
    const teamB = await team("Bravo Clinic", true);
    const plain = await team("Plain Co", false);
    const seat = (u: Id<"users">, tm: Id<"teams">, role: "admin" | "member") =>
      ctx.db.insert("team_memberships", { user_id: u, team_id: tm, role, joined_at: 1 } as any);
    await seat(admin, teamA, "admin");
    await seat(member, teamA, "member");
    await seat(adminB, teamB, "admin");
    await seat(plainAdmin, plain, "admin");
    await seat(plainMember, plain, "member");
    return { admin, member, adminB, plainAdmin, plainMember, teamA, teamB, plain };
  });
  const as = (u: Id<"users">) => t.withIdentity({ subject: `${u}|session` });
  return { t, ...ids, as };
}

async function conversation(t: any, user: Id<"users">, team: Id<"teams">, extra: Record<string, unknown> = {}): Promise<Id<"conversations">> {
  return t.run((ctx: any) =>
    ctx.db.insert("conversations", {
      user_id: user, team_id: team, agent_type: "claude_code", session_id: crypto.randomUUID(),
      started_at: 1, updated_at: 1, message_count: 0, status: "completed", title: "Intake notes", ...extra,
    }),
  );
}

/** Let the scheduled passes run until the delete's row says done. */
async function drain(t: any, find: (ctx: any) => Promise<any>): Promise<any> {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 15));
    await t.finishInProgressScheduledFunctions();
    const d = await t.run(find);
    if (d?.status === "done") return d;
  }
  throw new Error("delete did not finish");
}

const deletionOf = (kind: string, target: string) => (ctx: any) =>
  ctx.db.query("data_deletions").withIndex("by_target", (q: any) => q.eq("kind", kind).eq("target_id", target)).first();

// ── Coverage ──────────────────────────────────────────────────────────────

describe("coverage map", () => {
  const covered = new Set<string>();
  const nodes: PurgeNode[] = [];
  const walk = (n: PurgeNode) => { covered.add(n.table); nodes.push(n); n.children?.forEach(walk); };
  [...conversationRowPlan(), ...teamDeletionSteps(), artifactPlan(), callPlan()].forEach(walk);

  test("every node reads an index that exists and leads on its field", () => {
    for (const n of nodes) {
      const idx = tables[n.table]?.indexes.find((i: any) => i.indexDescriptor === n.index);
      expect({ table: n.table, index: n.index, lead: idx?.fields[0] }).toEqual({ table: n.table, index: n.index, lead: n.field });
    }
  });

  test("every table keyed by a conversation, team, workspace or call is in a plan or left out with a reason", () => {
    const keys = ["conversation_id", "team_id", "workspace", "scope_key", "transcript_id", "artifact_id"];
    const missing = Object.entries(tables)
      .filter(([name, t]) => !covered.has(name) && !(name in LEFT_OUT) && Object.keys(t.validator.fields).some((f) => keys.includes(f)))
      .map(([name]) => name);
    expect(missing).toEqual([]);
    expect(Object.keys(LEFT_OUT).filter((name) => covered.has(name) || !tables[name])).toEqual([]);
  });
});

// ── Sessions ──────────────────────────────────────────────────────────────

describe("regulated session delete", () => {
  test("a team admin deletes a member's session; every covered table loses its rows, and the delete is logged", async () => {
    const { t, admin, member, teamA, as } = await setup();
    const conv = await conversation(t, member, teamA);
    const seeded: Seeded[] = [];
    await t.run(async (ctx: any) => seedTree(ctx, conversationRowPlan(), { _id: conv }, new Map(), seeded));
    expect(new Set(seeded.map((s) => s.table)).size).toBeGreaterThan(45);

    await as(admin).mutation(api.sessionDelete.deleteSession, { conversation_id: conv });
    const d = await drain(t, deletionOf("session", String(conv)));

    expect(await t.run((ctx: any) => ctx.db.get(conv))).toBeNull();
    expect(await left(t, seeded)).toEqual([]);
    // The db wrapper (functions.ts) drops these the moment the conversation row goes, before the job runs.
    const followConversation = new Set(["session_starts", "change_story_inputs"]);
    expect([...new Set(seeded.map((s) => s.table))].filter((table) => !followConversation.has(table) && !(d.counts[table] > 0))).toEqual([]);
    expect(d).toMatchObject({ kind: "session", team_id: teamA, actor_user_id: admin, roots: [] });
    const log = await t.run((ctx: any) => ctx.db.query("access_log").withIndex("by_team_at", (q: any) => q.eq("team_id", teamA)).collect());
    expect(log.filter((r: any) => r.action === "delete" && r.object_id === String(conv)).map((r: any) => r.detail.split(":")[0]).sort()).toEqual(["deleted", "requested"]);
    // The owner's daemon will not upload it again.
    const tomb = await t.run((ctx: any) => ctx.db.query("deleted_sessions").collect());
    expect(tomb.map((r: any) => r.conversation_id)).toContain(String(conv));
  });

  test("a member cannot delete a teammate's session, and an admin of another team cannot either", async () => {
    const { t, member, adminB, admin, teamA, as } = await setup();
    const conv = await conversation(t, admin, teamA);
    await expect(as(member).mutation(api.sessionDelete.deleteSession, { conversation_id: conv })).rejects.toThrow();
    await expect(as(adminB).mutation(api.sessionDelete.deleteSession, { conversation_id: conv })).rejects.toThrow();
    expect(await t.run((ctx: any) => ctx.db.get(conv))).not.toBeNull();
  });

  test("a team without regulated data keeps the ordinary delete: owner only, no record, the ordinary purge", async () => {
    const { t, plainAdmin, plainMember, plain, as } = await setup();
    const conv = await conversation(t, plainMember, plain);
    const seeded: Seeded[] = [];
    await t.run(async (ctx: any) => seedTree(ctx, conversationRowPlan(), { _id: conv }, new Map(), seeded));
    await expect(as(plainAdmin).mutation(api.sessionDelete.deleteSession, { conversation_id: conv })).rejects.toThrow();

    await as(plainMember).mutation(api.sessionDelete.deleteSession, { conversation_id: conv });
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 15)); await t.finishInProgressScheduledFunctions(); }
    expect(await t.run((ctx: any) => ctx.db.query("data_deletions").collect())).toEqual([]);
    const alive = await left(t, seeded);
    expect(alive).not.toContain("messages");
    // What only a regulated delete reaches is still there.
    expect(alive).toContain("tree_snapshots");
  });
});

// ── Pages and calls ───────────────────────────────────────────────────────

describe("regulated page and call deletes", () => {
  test("a team admin deletes a member's gated page and everything it owns", async () => {
    const { t, admin, member, adminB, teamA, as } = await setup();
    const seeded: Seeded[] = [];
    const page = await t.run(async (ctx: any) => {
      const made = new Map();
      const id = await row(ctx, "artifacts", { slug: "pg-1", user_id: member, team_gate: teamA }, made);
      seeded.push({ table: "artifacts", id: String(id) });
      await seedTree(ctx, artifactPlan().children!, await ctx.db.get(id), made, seeded);
      return id;
    });
    expect(await as(adminB).mutation(api.artifacts.deleteForWeb, { slug: "pg-1" })).toEqual({ error: "Not found" });
    expect(await as(admin).mutation(api.artifacts.deleteForWeb, { slug: "pg-1" })).toEqual({ ok: true });
    const d = await drain(t, deletionOf("page", String(page)));
    expect(await left(t, seeded)).toEqual([]);
    expect(d.counts.storage_files).toBeGreaterThan(0);
  });

  test("a team admin deletes a call with its transcript; a member and another team's admin are refused", async () => {
    const { t, admin, member, adminB, teamA, as } = await setup();
    const seeded: Seeded[] = [];
    const call = await t.run(async (ctx: any) => {
      const made = new Map();
      const id = await row(ctx, "transcripts", { team_id: teamA, status: "ended" }, made);
      seeded.push({ table: "transcripts", id: String(id) });
      await seedTree(ctx, callPlan().children!, await ctx.db.get(id), made, seeded);
      return id;
    });
    await expect(as(member).mutation(api.regulatedDeletion.deleteCall, { transcript_id: call })).rejects.toThrow();
    await expect(as(adminB).mutation(api.regulatedDeletion.deleteCall, { transcript_id: call })).rejects.toThrow();
    await as(admin).mutation(api.regulatedDeletion.deleteCall, { transcript_id: call });
    await drain(t, deletionOf("call", String(call)));
    expect(await left(t, seeded)).toEqual([]);
  });

  test("a live call is refused", async () => {
    const { t, admin, teamA, as } = await setup();
    const call = await t.run((ctx: any) => row(ctx, "transcripts", { team_id: teamA, status: "live" }, new Map()));
    await expect(as(admin).mutation(api.regulatedDeletion.deleteCall, { transcript_id: call })).rejects.toThrow(/End the call/);
  });
});

// ── The whole team ────────────────────────────────────────────────────────

describe("whole-team destroy", () => {
  test("pages through a team bigger than one pass, removes every covered row and the team, and cannot be restored", async () => {
    const { t, admin, member, teamA, teamB, as } = await setup();
    const seeded: Seeded[] = [];
    await t.run(async (ctx: any) => seedTree(ctx, teamDeletionSteps(), { _id: teamA }, new Map(), seeded));
    // Bulk: more message weight than several passes' budget.
    const bulk = 30, perConv = 15;
    for (let c = 0; c < bulk; c++) {
      const conv = await conversation(t, c % 2 ? admin : member, teamA);
      await t.run(async (ctx: any) => {
        for (let m = 0; m < perConv; m++) {
          seeded.push({ table: "messages", id: String(await row(ctx, "messages", { conversation_id: conv }, new Map())) });
        }
      });
      seeded.push({ table: "conversations", id: String(conv) });
    }
    // Another regulated team's session, which must survive.
    const other = await conversation(t, admin, teamB);

    const preview = await as(admin).query(api.regulatedDeletion.destroyPreview, { team_id: teamA });
    expect(preview!.sessions.n).toBeGreaterThanOrEqual(bulk);
    expect(await as(member).query(api.regulatedDeletion.destroyPreview, { team_id: teamA })).toBeNull();

    await expect(as(admin).mutation(api.regulatedDeletion.destroyTeam, { team_id: teamA, confirm_name: "acme" })).rejects.toThrow(/team name/);
    await as(admin).mutation(api.regulatedDeletion.destroyTeam, { team_id: teamA, confirm_name: "Acme Health" });
    // Access ends at once, before the data is gone.
    expect(await t.run((ctx: any) => ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamA)).collect())).toEqual([]);

    const d = await drain(t, deletionOf("team", String(teamA)));
    expect(d.passes).toBeGreaterThan(Math.ceil((bulk * perConv * 10) / DELETION_PASS_BUDGET));
    expect(await left(t, seeded)).toEqual([]);
    expect(await t.run((ctx: any) => ctx.db.get(teamA))).toBeNull();
    expect(d.counts.messages).toBeGreaterThanOrEqual(bulk * perConv);
    expect(await t.run((ctx: any) => ctx.db.get(other))).not.toBeNull();
    // The request was logged while the team was still live.
    const log = await t.run((ctx: any) => ctx.db.query("access_log").withIndex("by_team_at", (q: any) => q.eq("team_id", teamA)).collect());
    expect(log.some((r: any) => r.action === "delete" && r.object_table === "teams")).toBe(true);
    await expect(t.mutation(internal.teams.restoreTeam, { team_id: teamA })).rejects.toThrow();
  });

  test("a member is refused, an admin of another team is refused, and a team without regulated data is refused", async () => {
    const { t, member, adminB, plainAdmin, teamA, plain, as } = await setup();
    await expect(as(member).mutation(api.regulatedDeletion.destroyTeam, { team_id: teamA, confirm_name: "Acme Health" })).rejects.toThrow();
    await expect(as(adminB).mutation(api.regulatedDeletion.destroyTeam, { team_id: teamA, confirm_name: "Acme Health" })).rejects.toThrow();
    await expect(as(plainAdmin).mutation(api.regulatedDeletion.destroyTeam, { team_id: plain, confirm_name: "Plain Co" })).rejects.toThrow(/regulated/);
    expect(await t.run((ctx: any) => ctx.db.query("data_deletions").collect())).toEqual([]);
    expect(await t.run((ctx: any) => ctx.db.get(teamA))).toMatchObject({ name: "Acme Health" });
  });

  test("a stalled delete resumes from its recorded roots", async () => {
    const { t, admin, teamA, as } = await setup();
    // More than one pass of work, so the chain is cut mid-way.
    for (let c = 0; c < 12; c++) {
      const conv = await conversation(t, admin, teamA);
      await t.run(async (ctx: any) => { for (let m = 0; m < 10; m++) await row(ctx, "messages", { conversation_id: conv }, new Map()); });
    }
    await as(admin).mutation(api.regulatedDeletion.destroyTeam, { team_id: teamA, confirm_name: "Acme Health" });
    // The chain is lost: bump its generation so the scheduled pass ends, and age it.
    await t.run(async (ctx: any) => {
      const d = await deletionOf("team", String(teamA))(ctx);
      await ctx.db.patch(d._id, { gen: d.gen + 7, updated_at: 0 });
    });
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 15)); await t.finishInProgressScheduledFunctions(); }
    expect((await t.run(deletionOf("team", String(teamA)))).status).toBe("running");
    expect(await t.mutation(internal.regulatedDeletion.resumeStalledDeletions, {})).toEqual({ resumed: 1 });
    await drain(t, deletionOf("team", String(teamA)));
    expect(await t.run((ctx: any) => ctx.db.get(teamA))).toBeNull();
  });
});
