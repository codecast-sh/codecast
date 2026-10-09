// Live data on published pages (pageData.ts, lib/pageReaders.ts): the
// declaration and the reader registry, refusal of anything the publisher
// cannot read, the refresh lease a crowd of viewers shares, and the data
// route answering only past the page's own gates.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { httpRouter } from "convex/server";
import schema from "./schema";
import { internal } from "./_generated/api";
import { serve } from "./artifactsHttp";
import { kTokenFor, eTokenFor } from "./lib/artifactGates";
import { PAGE_READERS, tableFromJson, windowStart, dayKey } from "./lib/pageReaders";
import { dueAt } from "./pageData";
import { parsePageDataDeclaration, parseRefresh, pageUsesData, capResult } from "@codecast/shared/contracts/pageData";

const router = httpRouter();
router.route({ pathPrefix: "/cli/a/", method: "GET", handler: serve });

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./artifacts.ts": () => import("./artifacts"),
  "./pageData.ts": () => import("./pageData"),
  "./http.ts": async () => ({ default: router }),
};

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Pat" } as any);
    const outsider = await ctx.db.insert("users", { name: "Out" } as any);
    const team = await ctx.db.insert("teams", { name: "Crew", created_at: 1 } as any);
    const otherTeam = await ctx.db.insert("teams", { name: "Elsewhere", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: outsider, team_id: otherTeam, role: "admin", joined_at: 1 } as any);
    const storage = await ctx.storage.store(new Blob(["<html><head></head><body><cast-stat query='done'></cast-stat></body></html>"], { type: "text/html" }));
    const artifact = await ctx.db.insert("artifacts", { slug: "dashslug01", user_id: owner, title: "Dash", storage_id: storage, size: 10, version: 1, created_at: 1, updated_at: 1 } as any);
    return { owner, outsider, team, otherTeam, artifact };
  });
  const validate = (declaration: unknown, owner = ids.owner) => t.query(internal.pageData.validateDeclaration, { owner, declaration });
  return { t, ...ids, validate };
}

describe("declaration and registry", () => {
  test("parses ids, readers and intervals, and refuses what cannot run", () => {
    expect(parseRefresh("15m")).toBe(900_000);
    expect(parseRefresh(undefined)).toBe(900_000);
    expect(parseRefresh("30s")).toEqual({ error: "refresh must be at least 1m" });
    expect(parseRefresh("2d")).toEqual({ error: "refresh must be at most 1d" });
    const ok = parsePageDataDeclaration({ queries: { done: { reader: "tasks", args: { view: "done_per_day" }, refresh: "1h", title: "Done" } } });
    expect(ok).toMatchObject({ ok: true, queries: [{ id: "done", reader: "tasks", refresh_ms: 3_600_000, title: "Done" }] });
    expect(parsePageDataDeclaration({ queries: { "Bad Id": { reader: "tasks" } } })).toMatchObject({ ok: false });
    expect(parsePageDataDeclaration({ queries: { a: { reader: "sql" } } })).toMatchObject({ ok: false, error: expect.stringContaining('unknown reader "sql"') });
    expect(parsePageDataDeclaration({ queries: {}, workspace: "everyone" })).toMatchObject({ ok: false });
  });

  test("each reader checks its own args and writes an audit line", () => {
    expect(PAGE_READERS.tasks.validate({ view: "done_per_day", days: 14 })).toEqual({
      args: { view: "done_per_day", days: 14, board: "human" },
      text: "tasks on the human board, closed as done per day over the last 14 days",
    });
    expect(PAGE_READERS.tasks.validate({ view: "burndown" })).toEqual({ error: '"view" must be one of status, project, assignee, done_per_day, created_per_day' });
    expect(PAGE_READERS.sessions.validate({ days: 400 })).toEqual({ error: '"days" must be a whole number from 1 to 90' });
    expect(PAGE_READERS.usage.validate({ dayz: 3 })).toMatchObject({ error: expect.stringContaining('unknown arg "dayz"') });
    expect(PAGE_READERS.metric.validate({ watch: "12" })).toMatchObject({ error: expect.stringContaining("mw-12") });
    expect(PAGE_READERS.hogql.validate({ source: "posthog" })).toEqual({ error: '"query" is required' });
  });

  test("folds fill quiet days and tables come from any JSON shape", () => {
    const now = Date.UTC(2026, 9, 8, 12);
    const table = PAGE_READERS.signals.fold!([[dayKey(now), "bug"], [dayKey(now), "bug"]], { days: 3, group_by: "none" }, now);
    expect(table).toEqual({ columns: ["day", "signals"], rows: [["2026-10-06", 0], ["2026-10-07", 0], ["2026-10-08", 2]] });
    expect(windowStart(now, 1)).toBe(Date.UTC(2026, 9, 8));
    expect(tableFromJson([{ a: 1, b: "x" }, { a: 2, c: true }])).toEqual({ columns: ["a", "b", "c"], rows: [[1, "x", undefined], [2, undefined, true]] });
    expect(tableFromJson({ total: 3 })).toEqual({ columns: ["key", "value"], rows: [["total", 3]] });
    expect(capResult(["n"], Array.from({ length: 5000 }, (_, i) => [i])).rows).toHaveLength(2000);
    expect(pageUsesData("<cast-chart query=x>")).toBe(true);
    expect(pageUsesData("<span data-cast-data=\"spend\">")).toBe(true);
    expect(pageUsesData("<p>cast data</p>")).toBe(false);
  });
});

describe("access at publish", () => {
  test("a team workspace the publisher belongs to is accepted, with the query text", async () => {
    const { validate, team } = await setup();
    const out = await validate({ workspace: `team:${team}`, queries: { done: { reader: "tasks", args: { view: "status" } } } });
    expect(out).toMatchObject({ ok: true, workspace: `team:${team}` });
    if (out.ok) expect(out.queries[0].query_text).toBe("tasks on the human board, updated in the last 30 days, counted by status; in the team workspace");
  });

  test("a workspace the publisher cannot read is refused", async () => {
    const { validate, otherTeam, outsider } = await setup();
    expect(await validate({ workspace: `team:${otherTeam}`, queries: { done: { reader: "tasks" } } })).toEqual({
      ok: false,
      error: `You can't read workspace team:${otherTeam}, so a page of yours can't show it`,
    });
    expect(await validate({ workspace: `user:${outsider}`, queries: { done: { reader: "tasks" } } })).toMatchObject({ ok: false });
  });

  test("a source or watch outside the workspace is refused by name", async () => {
    const { t, validate, team, otherTeam, outsider } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("metric_watches", {
        workspace: `team:${otherTeam}`, source_id: (await ctx.db.insert("event_sources", { workspace: `team:${otherTeam}`, owner_user_id: outsider, short_id: "src-9", provider: "posthog", name: "theirs", promote: [], status: "active", created_at: 1, updated_at: 1 } as any)),
        short_id: "mw-7", created_by: outsider, name: "Signups", query_kind: "hogql", query: "select 1", threshold: 1, direction: "above", interval_ms: 60_000, status: "active", points: [], state: "ok", created_at: 1, updated_at: 1,
      } as any);
    });
    const ws = `team:${team}`;
    expect(await validate({ workspace: ws, queries: { m: { reader: "metric", args: { watch: "mw-7" } } } })).toEqual({ ok: false, error: 'query "m" (metric): no metric watch mw-7 in this workspace' });
    expect(await validate({ workspace: ws, queries: { h: { reader: "hogql", args: { source: "theirs", query: "select 1" } } } })).toMatchObject({ ok: false, error: expect.stringContaining('no source "theirs" in this workspace') });
    expect(await validate({ workspace: ws, queries: { p: { reader: "prs" } } })).toMatchObject({ ok: true });
    expect(await validate({ workspace: `user:${(await setup()).owner}`, queries: { p: { reader: "prs" } } })).toMatchObject({ ok: false });
  });
});

describe("refresh on read", () => {
  test("one lease per stale query: a crowd of viewers starts one refresh", async () => {
    const { t, team, artifact } = await setup();
    await t.mutation(internal.pageData.replaceQueries, {
      slug: "dashslug01", owner: (await t.run(async (ctx) => (await ctx.db.get(artifact))!.user_id)), workspace: `team:${team}`,
      queries: [{ query_id: "done", position: 0, reader: "tasks", args_json: JSON.stringify({ view: "status", days: 30, board: "human" }), query_text: "q", refresh_ms: 60_000 }],
    });
    // The publish itself leased the new query; viewers arriving meanwhile take none.
    expect(await t.mutation(internal.pageData.claimRefresh, { artifact_id: artifact })).toEqual([]);
    const row = (await t.query(internal.pageData.forServe, { artifact_id: artifact }))[0];
    expect(row.lease_until).toBeGreaterThan(Date.now());
    await t.mutation(internal.pageData.storeResult, { id: row._id, args_json: row.args_json, result_json: JSON.stringify({ columns: ["status", "tasks"], rows: [["done", 3]] }), at: Date.now() });
    // Fresh: nothing to do until its interval passes.
    expect(await t.mutation(internal.pageData.claimRefresh, { artifact_id: artifact })).toEqual([]);
    await t.run(async (ctx) => ctx.db.patch(row._id, { refreshed_at: Date.now() - 61_000, attempted_at: Date.now() - 61_000 }));
    expect(await t.mutation(internal.pageData.claimRefresh, { artifact_id: artifact })).toEqual(["done"]);
    expect(await t.mutation(internal.pageData.claimRefresh, { artifact_id: artifact })).toEqual([]);
  });

  test("a failed refresh keeps the last answer and waits its interval too", async () => {
    expect(dueAt({ refreshed_at: 1_000, attempted_at: 500_000, refresh_ms: 60_000 })).toBe(560_000);
    expect(dueAt({ refresh_ms: 60_000 })).toBe(0);
    // An interval under the floor is read as the floor.
    expect(dueAt({ refreshed_at: 1_000, refresh_ms: 10 })).toBe(61_000);
  });
});

describe("the data route", () => {
  async function withQuery(patch: Record<string, unknown>) {
    const ctx = await setup();
    await ctx.t.mutation(internal.pageData.replaceQueries, {
      slug: "dashslug01", owner: ctx.owner, workspace: `team:${ctx.team}`,
      queries: [{ query_id: "done", position: 0, reader: "tasks", args_json: "{}", query_text: "tasks by status", refresh_ms: 3_600_000 }],
    });
    await ctx.t.run(async (c) => {
      const row = (await c.db.query("page_queries").first())!;
      await c.db.patch(row._id, { result_json: JSON.stringify({ columns: ["status", "tasks"], rows: [["done", 3]] }), refreshed_at: Date.now(), lease_until: undefined });
      await c.db.patch(ctx.artifact, patch as any);
    });
    return ctx;
  }

  test("serves the declared results, never the args, owner or workspace, and no-store", async () => {
    const { t } = await withQuery({});
    const res = await t.fetch("/cli/a/dashslug01/_data", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as any;
    expect(body.queries.done).toMatchObject({ columns: ["status", "tasks"], rows: [["done", 3]], query_text: "tasks by status", stale: false });
    const text = JSON.stringify(body);
    expect(text).not.toContain("team:");
    expect(text).not.toContain("args_json");
    expect((await t.fetch("/cli/a/dashslug01/_data/done", { method: "GET" })).status).toBe(200);
    expect((await t.fetch("/cli/a/dashslug01/_data/nope", { method: "GET" })).status).toBe(404);
  });

  test("a password gate holds the data until its token is presented", async () => {
    const { t } = await withQuery({ password_hash: "hash-1" });
    const locked = await t.fetch("/cli/a/dashslug01/_data", { method: "GET" });
    expect(await locked.text()).not.toContain("tasks by status");
    const k = await kTokenFor("hash-1", "dashslug01");
    const open = await t.fetch(`/cli/a/dashslug01/_data?k=${k}`, { method: "GET" });
    expect(((await open.json()) as any).queries.done.rows).toEqual([["done", 3]]);
  });

  test("the email wall and expiry hold it too", async () => {
    const walled = await withQuery({ email_gate: true, owner_key: "ownerkey" });
    expect(await (await walled.t.fetch("/cli/a/dashslug01/_data", { method: "GET" })).text()).not.toContain("tasks by status");
    const e = await eTokenFor("ownerkey", "dashslug01");
    expect((await walled.t.fetch(`/cli/a/dashslug01/_data?e=${e}`, { method: "GET" })).status).toBe(200);
    const expired = await withQuery({ expires_at: Date.now() - 1 });
    const gone = await expired.t.fetch("/cli/a/dashslug01/_data", { method: "GET" });
    expect(gone.status).toBe(410);
  });

  test("the page itself gets the runtime with its gate token in the data URL", async () => {
    const { t } = await withQuery({ password_hash: "hash-1" });
    const k = await kTokenFor("hash-1", "dashslug01");
    const html = await (await t.fetch(`/cli/a/dashslug01?k=${k}`, { method: "GET" })).text();
    expect(html).toContain("/cli/data.js");
    expect(html).toContain(`/cli/a/dashslug01/_data?k=${k}`);
  });
});
