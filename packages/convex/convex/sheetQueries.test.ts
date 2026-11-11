// Live query tabs under convex-test: a refresh fills the tab from the sheet's
// workspace only, throttles, and shows a fetch error on the tab.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(120_000);

const refresh = makeFunctionReference<"mutation", { doc_id: Id<"docs">; tab: string }, any>("sheetQueries:refresh");

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const rosa = await ctx.db.insert("users", { name: "Rosa", email: "rosa@pies.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Pies", invite_code: "PIES1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: rosa, team_id: team, role: "admin", joined_at: 1 } as any);
    const sheet = await ctx.db.insert("docs", {
      user_id: rosa, team_id: team, workspace: `team:${team}`, title: "Board", content: "", doc_type: "sheet",
      source: "human", created_at: 1, updated_at: 1,
    } as any);
    const task = (short_id: string, title: string, status: string, workspace: string, updated_at: number) =>
      ctx.db.insert("tasks", {
        user_id: rosa, team_id: team, workspace, short_id, title, status, priority: "high", task_type: "task",
        source: "human", labels: ["a", "b"], created_at: updated_at, updated_at,
      } as any);
    await task("ct-1", "=SUM(A1)", "open", `team:${team}`, 2000);
    await task("ct-2", "Ship it", "in_progress", `team:${team}`, 3000);
    await task("ct-3", "Finished", "done", `team:${team}`, 4000);
    await task("ct-4", "Rosa's private task", "open", `user:${rosa}`, 5000);
    const extra = (short_id: string, f: Record<string, unknown>) =>
      ctx.db.insert("tasks", { user_id: rosa, team_id: team, workspace: `team:${team}`, short_id, title: short_id, status: "open", priority: "low", task_type: "task", source: "agent", created_at: 1500, updated_at: 1500, ...f } as any);
    await extra("ct-mined", { triage_status: "suggested" });
    await extra("ct-scratch", { ephemeral: true });
    return { rosa, team, sheet };
  });
  const as = t.withIdentity({ subject: `${ids.rosa}|session` });
  return { t, as, ...ids };
}

const cells = async (t: any, doc: Id<"docs">) =>
  Object.fromEntries(
    (await t.run((ctx: any) => ctx.db.query("live_elements").withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", doc).eq("layer", "main")).collect()))
      .filter((r: any) => !r.deleted && r.kind === "cell")
      .map((r: any) => [r.key, r.fields.input]),
  );

describe("sheet live query tabs", () => {
  test("a tasks tab fills from the sheet's workspace, open tasks in creation order, then throttles", async () => {
    const { t, as, sheet } = await setup();
    await as.mutation(api.liveArtifacts.apply, { doc_id: sheet, ops: [{ k: "tab:q", put: { kind: "tab", name: "Open", order: 1, query: { source: "tasks" } } }] });
    const r = await as.mutation(refresh, { doc_id: sheet, tab: "q" });
    expect(r.rows).toBe(2);
    const c = await cells(t, sheet);
    expect(c["c:q!A1"]).toBe("ID");
    expect(c["c:q!A2"]).toBe("ct-1");
    expect(c["c:q!B2"]).toBe("'=SUM(A1)");
    expect(c["c:q!A3"]).toBe("ct-2");
    expect(c["c:q!F2"]).toBe("a, b");
    expect(Object.values(c)).not.toContain("Rosa's private task");
    expect(Object.values(c)).not.toContain("Finished");
    expect(Object.values(c)).not.toContain("ct-mined");
    expect(Object.values(c)).not.toContain("ct-scratch");
    expect(await as.mutation(refresh, { doc_id: sheet, tab: "q" })).toEqual({ skipped: true });
  });

  test("an old task updated now makes the cut over newer ones, and refreshes keep rows in place", async () => {
    const { t, as, sheet, team } = await setup();
    const ws = `team:${team}`;
    const old = await t.run(async (ctx: any) => {
      const rosa = (await ctx.db.query("users").first())._id;
      const mk = (short_id: string, updated_at: number) =>
        ctx.db.insert("tasks", { user_id: rosa, team_id: team, workspace: ws, short_id, title: short_id, status: "open", priority: "low", task_type: "task", source: "human", created_at: updated_at, updated_at } as any);
      const old = await mk("ct-old", 10);
      for (let i = 0; i < 5; i++) await mk(`ct-new${i}`, 5_000 + i);
      return old;
    });
    await as.mutation(api.liveArtifacts.apply, { doc_id: sheet, ops: [{ k: "tab:q", put: { kind: "tab", name: "Open", order: 1, query: { source: "tasks", limit: 3 } } }] });
    await as.mutation(refresh, { doc_id: sheet, tab: "q" });
    let c = await cells(t, sheet);
    expect([c["c:q!A2"], c["c:q!A3"], c["c:q!A4"]]).toEqual(["ct-new2", "ct-new3", "ct-new4"]);

    // Someone touches the oldest task: it is now among the three most recently updated.
    await t.run((ctx: any) => ctx.db.patch(old, { updated_at: 9_000, title: "Revived" }));
    const again = () => as.mutation(api.liveArtifacts.apply, { doc_id: sheet, ops: [{ k: "tab:q", set: { refreshed_at: null } }] });
    await again();
    await as.mutation(refresh, { doc_id: sheet, tab: "q" });
    c = await cells(t, sheet);
    // Creation order: the revived task sits first, the two newest keep their order below it.
    expect([c["c:q!A2"], c["c:q!A3"], c["c:q!A4"]]).toEqual(["ct-old", "ct-new3", "ct-new4"]);
    expect(c["c:q!B2"]).toBe("Revived");

    // An update to a row already shown changes only that row.
    await t.run(async (ctx: any) => {
      const row = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", "ct-new3")).first();
      await ctx.db.patch(row._id, { updated_at: 9_500, title: "Renamed" });
    });
    await again();
    const r = await as.mutation(refresh, { doc_id: sheet, tab: "q" });
    c = await cells(t, sheet);
    expect([c["c:q!A2"], c["c:q!A3"], c["c:q!A4"]]).toEqual(["ct-old", "ct-new3", "ct-new4"]);
    expect(c["c:q!B3"]).toBe("Renamed");
    // Title + Updated stamp of one row, plus the tab's refreshed_at.
    expect(r.changed).toBeLessThanOrEqual(3);
  });

  test("a failing source writes its error onto the tab", async () => {
    const { t, as, sheet } = await setup();
    await as.mutation(api.liveArtifacts.apply, { doc_id: sheet, ops: [{ k: "tab:q", put: { kind: "tab", name: "Bad", order: 1, query: { source: "tasks", status: "nope" } } }] });
    const r = await as.mutation(refresh, { doc_id: sheet, tab: "q" });
    expect(r.error).toContain("Unknown task status");
    const tab = await t.run((ctx: any) => ctx.db.query("live_elements").withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", sheet).eq("layer", "main").eq("key", "tab:q")).first());
    expect(tab.fields.query_error).toContain("Unknown task status");
  });

  test("a sessions tab lists only what the team sees, never the refresher's own hidden sessions", async () => {
    const { t, as, sheet, rosa, team } = await setup();
    await t.run(async (ctx: any) => {
      const dev = await ctx.db.insert("users", { name: "Dev", email: "dev@pies.dev" } as any);
      await ctx.db.insert("team_memberships", { user_id: dev, team_id: team, role: "member", joined_at: 1 } as any);
      // Rosa hides her activity from the team; her sessions stay hers even when not marked private.
      const m = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", team)).collect();
      for (const row of m) if (String(row.user_id) === String(rosa)) await ctx.db.patch(row._id, { visibility: "hidden" });
      const conv = (user_id: any, title: string, updated_at: number) =>
        ctx.db.insert("conversations", { user_id, team_id: team, title, is_private: false, status: "active", agent_type: "claude_code", started_at: 1, updated_at, message_count: 3 } as any);
      await conv(rosa, "Rosa hidden work", 5000);
      await conv(dev, "Dev shared work", 4000);
    });
    await as.mutation(api.liveArtifacts.apply, { doc_id: sheet, ops: [{ k: "tab:s", put: { kind: "tab", name: "Sessions", order: 1, query: { source: "sessions" } } }] });
    await as.mutation(refresh, { doc_id: sheet, tab: "s" });
    const c = Object.values(await cells(t, sheet));
    expect(c).toContain("Dev shared work");
    expect(c).not.toContain("Rosa hidden work");
  });
});
