// Data dashboards under convex-test, end to end through the sheet source: a
// dashboard binds a KPI to a sheet range; `want` records the query and runs
// it; the answer lands for the dashboard; the check behind the number re-runs
// it and says when the source no longer gives the number shown; a refused
// query says why; access follows the doc; the CLI verbs print the same.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { dashboard } from "@codecast/shared/artifacts";

setDefaultTimeout(120_000);

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const rosa = await ctx.db.insert("users", { name: "Rosa", email: "rosa@pies.dev" } as any);
    const out = await ctx.db.insert("users", { name: "Out", email: "out@else.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Pies", invite_code: "PIES1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: rosa, team_id: team, role: "admin", joined_at: 1 } as any);
    const base = { user_id: rosa, team_id: team, workspace: `team:${team}`, content: "", source: "human", created_at: 1, updated_at: 1 };
    const sheet = await ctx.db.insert("docs", { ...base, title: "Pre-orders", doc_type: "sheet" } as any);
    const dash = await ctx.db.insert("docs", { ...base, title: "Holiday pre-orders", doc_type: "dashboard", share_token: "tok-1" } as any);
    return { rosa, out, team, sheet, dash };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  return { t, ...ids, as };
}

/** A refresh runs in a scheduled action: let it start, then wait for it. */
const settle = async (t: { finishInProgressScheduledFunctions: () => Promise<void> }) => {
  await new Promise((done) => setTimeout(done, 20));
  await t.finishInProgressScheduledFunctions();
};

const cells: Record<string, string> = { A1: "Flavor", B1: "Orders", A2: "Huckleberry", B2: "4100", A3: "Apple", B3: "2900", A4: "Total", B4: "=SUM(B2:B3)" };

async function writeSheet(t: any, as: any, user: Id<"users">, sheet: Id<"docs">, overrides: Record<string, string> = {}) {
  const ops = [{ k: "tab:s1", put: { kind: "tab", name: "Pies", order: 0 } }, ...Object.entries({ ...cells, ...overrides }).map(([a1, input]) => ({ k: `c:s1!${a1}`, put: { kind: "cell", input } }))];
  await as(user).mutation(api.liveArtifacts.apply, { doc_id: sheet, layer: "main", ops });
}

const kpi = (sheet: Id<"docs">) => ({ kind: "kpi", order: 1, title: "Pre-orders", query: { source: "sheet", args: { doc: String(sheet), range: "Pies!A1:B3" } }, field: "orders", agg: "sum" });

describe("data dashboards", () => {
  test("a KPI bound to a sheet range is read, shown, verified, and re-checked after the source changes", async () => {
    const { t, as, rosa, sheet, dash } = await setup();
    await writeSheet(t, as, rosa, sheet);
    const block = kpi(sheet);
    const q = dashboard.blockQuery(block)!;
    const { leased } = await as(rosa).mutation(api.dataRefresh.want, { doc_id: dash, queries: [q as any] });
    expect(leased).toEqual([dashboard.queryKey(q)]);
    await settle(t);

    const [result] = (await as(rosa).query(api.dataQueries.results, { doc_id: dash }))!;
    expect(result.error).toBeUndefined();
    expect(result.columns).toEqual(["flavor", "orders"]);
    expect(result.rows).toEqual([["Huckleberry", 4100], ["Apple", 2900]]);
    expect(result.query_text).toContain("cells Pies!A1:B3 of sheet");
    const ev = dashboard.evaluateKpi(block as any, result as any);
    expect(ev).toMatchObject({ state: "ok", display: "7,000" });
    expect(dashboard.checkBlock("kpi", block, result as any, Date.now())?.state).toBe("verified");

    // A second want inside the interval starts nothing: one read per query per interval.
    expect((await as(rosa).mutation(api.dataRefresh.want, { doc_id: dash, queries: [q as any] })).leased).toEqual([]);

    // The source changes; the check's re-run says the number moved.
    await writeSheet(t, as, rosa, sheet, { B3: "3400" });
    const fresh = await as(rosa).action(api.dataQueries.rerun, { doc_id: dash, qkey: dashboard.queryKey(q) });
    expect(dashboard.compareRerun("kpi", block, result as any, fresh as any)).toMatchObject({ same: false, before: "7,000", after: "7,500" });

    // The sheet loses the column the KPI folds: the check says it can't reproduce the number.
    await writeSheet(t, as, rosa, sheet, { B1: "Count" });
    const broken = await as(rosa).action(api.dataQueries.rerun, { doc_id: dash, qkey: dashboard.queryKey(q) });
    expect(dashboard.compareRerun("kpi", block, fresh as any, broken as any).problem).toContain('no column "orders"');
  });

  test("formulas in the range read as their computed values", async () => {
    const { t, as, rosa, sheet, dash } = await setup();
    await writeSheet(t, as, rosa, sheet);
    const out = await as(rosa).action(api.dataQueries.preview, { doc_id: dash, query: { source: "sheet", args: { doc: String(sheet), range: "Pies!A1:B4" } } });
    expect(out.rows[2]).toEqual(["Total", 7000]);
  });

  test("a query its reader refuses is stored with the reason and never run", async () => {
    const { t, as, rosa, dash } = await setup();
    const q = { source: "sheet", args: { doc: "nope", range: "A1:B2" } };
    expect((await as(rosa).mutation(api.dataRefresh.want, { doc_id: dash, queries: [q] })).leased).toEqual([]);
    const [r] = (await as(rosa).query(api.dataQueries.results, { doc_id: dash }))!;
    expect(r.error).toBe("no sheet nope in this workspace");
    expect(dashboard.checkBlock("kpi", { query: q, field: "x" }, r as any, Date.now())?.state).toBe("broken");
  });

  test("access follows the doc; a share link reads results and refreshes saved blocks only", async () => {
    const { t, as, rosa, out, sheet, dash } = await setup();
    await writeSheet(t, as, rosa, sheet);
    await expect(as(out).mutation(api.dataRefresh.want, { doc_id: dash, queries: [] })).rejects.toThrow();
    expect(await as(out).query(api.dataQueries.results, { doc_id: dash })).toBeNull();

    await as(rosa).mutation(api.liveArtifacts.apply, { doc_id: dash, layer: "main", ops: [{ k: "b_k", put: kpi(sheet) as any }] });
    expect((await t.mutation(api.dataRefresh.wantShared, { doc_id: dash, share_token: "wrong" })).leased).toEqual([]);
    expect((await t.mutation(api.dataRefresh.wantShared, { doc_id: dash, share_token: "tok-1" })).leased.length).toBe(1);
    await settle(t);
    const shared = await t.query(api.dataQueries.results, { doc_id: dash, share_token: "tok-1" });
    expect(shared![0].rows.length).toBe(2);
  });

  test("cast data check prints each block's value and check", async () => {
    const { t, as, rosa, sheet, dash } = await setup();
    await writeSheet(t, as, rosa, sheet);
    await as(rosa).mutation(api.liveArtifacts.apply, {
      doc_id: dash,
      layer: "main",
      ops: [
        { k: "b_k", put: kpi(sheet) as any },
        { k: "b_t", put: { kind: "text", order: 2, text: "We sold 58,500 pies" } },
      ],
    });
    const out = await t.action(internal.dataQueries.cliCheck, { user_id: rosa, actor: `u:${rosa}`, actor_name: "Rosa", doc_id: dash, args: [] });
    expect(out.text).toContain("Holiday pre-orders: 1 verified, 1 typed");
    expect(out.text).toContain('✓ b_k kpi "Pre-orders"  7,000');
    expect(out.text).toContain("? b_t text");
    const q = await t.action(internal.dataQueries.cliQuery, { user_id: rosa, actor: `u:${rosa}`, actor_name: "Rosa", doc_id: dash, args: ["sheet", "--args", JSON.stringify({ doc: String(sheet), range: "Pies!A1:B3" })] });
    expect(q.text).toContain("2 rows · columns: flavor, orders");
  });

  test("a share link never sees a draft's queries or an archived dashboard's rows", async () => {
    const { t, as, rosa, sheet, dash } = await setup();
    await writeSheet(t, as, rosa, sheet);
    const draftOnly = { source: "sheet", args: { doc: String(sheet), range: "Pies!A1:B2" } };
    await as(rosa).mutation(api.dataRefresh.want, { doc_id: dash, queries: [draftOnly] });
    await settle(t);
    expect((await as(rosa).query(api.dataQueries.results, { doc_id: dash }))!.length).toBe(1);
    expect(await t.query(api.dataQueries.results, { doc_id: dash, share_token: "tok-1" })).toEqual([]);
    await t.run((ctx: any) => ctx.db.patch(dash, { archived_at: Date.now() }));
    expect(await t.query(api.dataQueries.results, { doc_id: dash, share_token: "tok-1" })).toBeNull();
  });

  test("a slower, older read never overwrites a newer answer; a refused query never runs by hand", async () => {
    const { t, as, rosa, sheet, dash } = await setup();
    await writeSheet(t, as, rosa, sheet);
    const q = dashboard.blockQuery(kpi(sheet))!;
    await as(rosa).mutation(api.dataRefresh.want, { doc_id: dash, queries: [q as any] });
    await settle(t);
    const row: any = await t.run((ctx: any) => ctx.db.query("data_queries").first());
    const stamp = { id: row._id, args_json: row.args_json, workspace: row.workspace, owner_user_id: row.owner_user_id };
    const stale = await t.mutation(internal.dataQueries.storeResult, { ...stamp, started: row.refreshed_at - 5_000, result_json: JSON.stringify({ columns: ["x"], rows: [[1]] }), at: Date.now() });
    expect(stale).toBe(false);
    expect(JSON.parse((await t.run((ctx: any) => ctx.db.get(row._id))).result_json).columns).toEqual(["flavor", "orders"]);

    const bad = { source: "sheet", args: { doc: "nope", range: "A1:B2" } };
    await as(rosa).mutation(api.dataRefresh.want, { doc_id: dash, queries: [bad] });
    const r = await as(rosa).action(api.dataQueries.rerun, { doc_id: dash, qkey: dashboard.queryKey(bad) });
    expect(r.error).toBe("no sheet nope in this workspace");
    expect(r.rows).toEqual([]);
  });
});
