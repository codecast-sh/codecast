// The team's pool of flows (docs/architecture/flows.md FL2): a flow published
// by `cast flow publish` is filed under the publisher's team workspace and every
// member reads it; a draft, a graph that declares no kind=, a plain push, and
// a row from before keys stay their owner's. A non-member reads nothing.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

const api = anyApi as any;
const internal = anyApi as any;
setDefaultTimeout(120_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./workflows.ts": () => import("./workflows"),
};

const NODES = [
  { id: "start", label: "Start", shape: "Mdiamond", type: "start" },
  { id: "review", label: "Review", shape: "box", type: "agent", prompt: "Read the diff against $task_title." },
  { id: "exit", label: "Done", shape: "Msquare", type: "exit" },
];
const EDGES = [{ from: "start", to: "review" }, { from: "review", to: "exit" }];
const src = (name: string, attrs: string) => `digraph ${name} {\n  graph [${attrs}]\n  start [shape=Mdiamond]\n  review [prompt="@review.md"]\n  exit [shape=Msquare]\n  start -> review -> exit\n}`;

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com", active_team_id: team } as any);
    const bo = await ctx.db.insert("users", { name: "Bo", email: "bo@example.com", active_team_id: team } as any);
    const cy = await ctx.db.insert("users", { name: "Cy", email: "cy@example.com" } as any);
    for (const u of [ana, bo]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    for (const [u, tok] of [[ana, "tok-ana"], [bo, "tok-bo"], [cy, "tok-cy"]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(tok), name: "cli", created_at: now, last_used_at: now } as any);
    }
    return { team, ana, bo, cy };
  });
  const push = (slug: string, source: string, publish?: any, token = "tok-ana") =>
    t.mutation(api.workflows.upsert, { api_token: token, name: slug, slug, source, nodes: NODES, edges: EDGES, ...(publish ? { publish } : {}) });
  const pool = (u: string, team_id?: string) => t.withIdentity({ subject: `${u}|test` }).query(api.workflows.webPool, team_id ? { team_id } : {});
  const slugs = (rows: any[]) => rows.map((r) => r.slug).sort();
  return { t, ...ids, push, pool, slugs };
}

describe("the team's pool of flows", () => {
  test("a teammate reads a published flow, and not a draft, a graph with no kind, or a plain push", async () => {
    const s = await seed();
    const team = { workspace: "team", team_id: s.team };
    await s.push("review-pass", src("review_pass", 'kind="segment", label="Review pass"'), team);
    await s.push("half-done", src("half_done", 'kind="segment", draft="jx7abcd"'));
    await s.push("probe", src("probe", 'label="Probe"'));
    await s.push("mine-only", src("mine_only", 'kind="line"'));

    expect(s.slugs(await s.pool(s.bo, s.team))).toEqual(["review-pass"]);
    const cli = await s.t.query(api.workflows.poolForCli, { api_token: "tok-bo", team_id: s.team });
    expect(cli.flows.map((f: any) => [f.slug, f.by, f.mine])).toEqual([["review-pass", "Ana", false]]);
    expect(cli.flows[0].nodes.find((n: any) => n.id === "review").prompt).toBe("Read the diff against $task_title.");

    // The publisher's own unpublished flow is in her personal pool, never the team's.
    expect(s.slugs(await s.pool(s.ana))).toEqual(["mine-only"]);
    expect(s.slugs(await s.pool(s.bo))).toEqual([]);

    // Someone outside the team reads nothing of it, by either path.
    expect(await s.pool(s.cy, s.team)).toEqual([]);
    expect((await s.t.query(api.workflows.poolForCli, { api_token: "tok-cy", team_id: s.team })).flows).toEqual([]);
  });

  test("the row carries the team key as access and team_id as routing", async () => {
    const s = await seed();
    await s.push("review-pass", src("review_pass", 'kind="segment"'), { workspace: "team", team_id: s.team });
    await s.push("probe", src("probe", 'label="Probe"'));
    const rows = await s.t.run((ctx) => ctx.db.query("workflows").collect());
    const by = Object.fromEntries(rows.map((r: any) => [r.slug, r]));
    expect([by["review-pass"].workspace, by["review-pass"].team_id]).toEqual([`team:${s.team}`, s.team]);
    expect([by.probe.workspace, by.probe.team_id]).toEqual([`user:${s.ana}`, undefined]);
  });

  test("a draft or a graph with no kind is refused a publish; a team the publisher is not in is refused", async () => {
    const s = await seed();
    await expect(s.push("half-done", src("half_done", 'kind="segment", draft="jx7abcd"'), { workspace: "team", team_id: s.team })).rejects.toThrow(/kind=/);
    await expect(s.push("probe", src("probe", 'label="Probe"'), { workspace: "team", team_id: s.team })).rejects.toThrow(/kind=/);
    await expect(s.push("review-pass", src("review_pass", 'kind="segment"'), { workspace: "team", team_id: s.team }, "tok-cy")).rejects.toThrow();
  });

  test("a later run's push keeps a published flow in the pool; turning it back into a draft takes it out", async () => {
    const s = await seed();
    await s.push("review-pass", src("review_pass", 'kind="segment"'), { workspace: "team", team_id: s.team });
    await s.push("review-pass", src("review_pass", 'kind="segment", label="Review pass v2"'));
    expect(s.slugs(await s.pool(s.bo, s.team))).toEqual(["review-pass"]);
    await s.push("review-pass", src("review_pass", 'kind="segment", draft="jx7abcd"'));
    expect(await s.pool(s.bo, s.team)).toEqual([]);
  });

  test("a row from before keys stays its owner's, and the backfill files it so", async () => {
    const s = await seed();
    const now = Date.now();
    // The old insert copied the user's team onto every row.
    const old = await s.t.run((ctx) => ctx.db.insert("workflows", { user_id: s.ana, team_id: s.team, name: "old", slug: "old", source: src("old", 'kind="segment"'), nodes: NODES, edges: EDGES, created_at: now, updated_at: now } as any));
    expect(await s.pool(s.bo, s.team)).toEqual([]);
    expect(await s.t.mutation(internal.workflows.backfillWorkspace, {})).toEqual({ stamped: 1 });
    const row: any = await s.t.run((ctx) => ctx.db.get(old));
    expect([row.workspace, row.team_id]).toEqual([`user:${s.ana}`, undefined]);
    expect(s.slugs(await s.pool(s.ana))).toEqual(["old"]);
    expect(await s.pool(s.bo, s.team)).toEqual([]);
    expect(await s.t.mutation(internal.workflows.backfillWorkspace, {})).toEqual({ stamped: 0 });
  });
});
