// Live data on published pages (pageData.ts, lib/pageReaders.ts): the
// declaration and the reader registry, refusal of anything the publisher
// cannot read, the refresh lease a crowd of viewers shares, and the data
// route answering only past the page's own gates.
import { describe, expect, jest, test } from "bun:test";
import { convexTest } from "convex-test";
import { httpRouter } from "convex/server";
import schema from "./schema";
import { internal } from "./_generated/api";
import { serve } from "./artifactsHttp";
import { kTokenFor, eTokenFor } from "./lib/artifactGates";
import { PAGE_READERS, tableFromJson, windowStart, dayKey } from "./lib/pageReaders";
import { dueAt } from "./pageData";
import { makeSessionStartsDb } from "./lib/sessionStarts";
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

const setJson = (workspace: string, queries: Array<Record<string, unknown>>) => JSON.stringify({ workspace, queries });

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
    // A grouped series names its group column for what it groups by, so series="agent" finds it.
    expect(PAGE_READERS.sessions.fold!([[dayKey(now), "codex"]], { days: 1, group_by: "agent" }, now)).toEqual({ columns: ["day", "agent", "sessions"], rows: [["2026-10-08", "codex", 1]] });
    expect(PAGE_READERS.signals.fold!([[dayKey(now), "bug"]], { days: 1, group_by: "kind" }, now).columns).toEqual(["day", "kind", "signals"]);
    // Pull requests: the plain series keeps its shape; a split by author has one row per day and author that saw any.
    const prs = [[dayKey(now), "opened", "ada"], [dayKey(now), "merged", "ada"], [dayKey(now), "opened", "bo"]];
    expect(PAGE_READERS.prs.fold!(prs.map(([d, w]) => [d, w, ""]), { days: 1 }, now)).toEqual({ columns: ["day", "opened", "merged"], rows: [["2026-10-08", 2, 1]] });
    expect(PAGE_READERS.prs.fold!(prs, { days: 1, group_by: "author" }, now)).toEqual({ columns: ["day", "author", "opened", "merged"], rows: [["2026-10-08", "ada", 1, 1], ["2026-10-08", "bo", 1, 0]] });
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

  test("queries keep the file's order, which Convex would otherwise sort", async () => {
    const { t, owner, team } = await setup();
    const out = await t.query(internal.pageData.validateDeclaration, {
      owner,
      declaration: { workspace: `team:${team}`, queries: { zeta: { reader: "tasks" }, alpha: { reader: "signals" } } },
      order: ["zeta", "alpha"],
    });
    expect(out.ok && out.queries.map((q) => [q.query_id, q.position])).toEqual([["zeta", 0], ["alpha", 1]]);
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
      slug: "dashslug01", owner: (await t.run(async (ctx) => (await ctx.db.get(artifact))!.user_id)), version: 1,
      set_json: setJson(`team:${team}`, [{ query_id: "done", position: 0, reader: "tasks", args_json: JSON.stringify({ view: "status", days: 30, board: "human" }), query_text: "q", refresh_ms: 60_000 }]),
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
    // replaceQueries schedules a first refresh of the new query. Run it to completion before planting the fixture's
    // answer, so nothing can land afterwards and overwrite it, however the machine schedules the timer.
    jest.useFakeTimers();
    try {
      await ctx.t.mutation(internal.pageData.replaceQueries, {
        slug: "dashslug01", owner: ctx.owner, version: 1,
        set_json: setJson(`team:${ctx.team}`, [{ query_id: "done", position: 0, reader: "tasks", args_json: "{}", query_text: "tasks by status", refresh_ms: 3_600_000 }]),
      });
      await ctx.t.finishAllScheduledFunctions(() => jest.runAllTimers());
    } finally {
      jest.useRealTimers();
    }
    await ctx.t.run(async (c) => {
      const row = (await c.db.query("page_queries").first())!;
      await c.db.patch(row._id, { result_json: JSON.stringify({ columns: ["status", "tasks"], rows: [["done", 3]] }), refreshed_at: Date.now(), lease_until: undefined });
      await c.db.patch(ctx.artifact, patch as any);
    });
    return ctx;
  }

  test("serves the declared results with their exact call, never the owner, and no-store", async () => {
    const { t } = await withQuery({});
    const res = await t.fetch("/cli/a/dashslug01/_data", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as any;
    expect(body.queries.done).toMatchObject({ columns: ["status", "tasks"], rows: [["done", 3]], query_text: "tasks by status", stale: false });
    expect(body.queries.done.call).toEqual({ reader: "tasks", args: {}, workspace: expect.stringMatching(/^team:/) });
    const text = JSON.stringify(body);
    expect(text).not.toContain("owner");
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

describe("rollback restores the version's queries", () => {
  test("each version keeps its set; a rollback brings the old one back", async () => {
    const { t, owner, team, artifact } = await setup();
    const a = setJson(`team:${team}`, [{ query_id: "done", position: 0, reader: "tasks", args_json: "{}", query_text: "A", refresh_ms: 3_600_000 }]);
    const b = setJson(`team:${team}`, [{ query_id: "spend", position: 0, reader: "usage", args_json: "{}", query_text: "B", refresh_ms: 3_600_000 }]);
    await t.mutation(internal.pageData.replaceQueries, { slug: "dashslug01", owner, version: 1, set_json: a });
    await t.mutation(internal.pageData.replaceQueries, { slug: "dashslug01", owner, version: 2, set_json: b });
    const ids = async () => (await t.query(internal.pageData.forServe, { artifact_id: artifact })).map((r: any) => r.query_id);
    expect(await ids()).toEqual(["spend"]);
    // An in-browser edit (v3) records no set and inherits v2's.
    expect(await t.query(internal.pageData.setAt, { artifact_id: artifact, version: 3 })).toBe(b);
    expect(await t.mutation(internal.pageData.restoreSet, { artifact_id: artifact, from_version: 1, to_version: 4 })).toEqual({ restored: true });
    expect(await ids()).toEqual(["done"]);
    expect(await t.query(internal.pageData.setAt, { artifact_id: artifact, version: 4 })).toBe(a);
    // A version from before live data restores nothing and leaves the current set.
    expect(await t.mutation(internal.pageData.restoreSet, { artifact_id: artifact, from_version: 0, to_version: 5 })).toEqual({ restored: false });
    expect(await ids()).toEqual(["done"]);
  });
});

describe("session_starts follows conversation writes", () => {
  test("insert, privacy change and delete each re-derive the row", async () => {
    const { t, owner, team } = await setup();
    const row = () => t.run(async (ctx) => await ctx.db.query("session_starts").first());
    const convId = await t.run(async (ctx) => {
      const db = makeSessionStartsDb(ctx.db, ctx.db);
      return await db.insert("conversations", { user_id: owner, team_id: team, is_private: false, agent_type: "codex", started_at: 1_000, status: "active", message_count: 0, updated_at: 1_000 } as any);
    });
    expect(await row()).toMatchObject({ conversation_id: convId, user_id: owner, visible_team_id: team, agent_type: "codex", started_at: 1_000, subagent: false });
    await t.run(async (ctx) => makeSessionStartsDb(ctx.db, ctx.db).patch(convId, { is_private: true }));
    expect((await row())!.visible_team_id).toBeUndefined();
    // A heartbeat touches nothing the row derives from.
    await t.run(async (ctx) => makeSessionStartsDb(ctx.db, ctx.db).patch(convId, { updated_at: 2_000 }));
    await t.run(async (ctx) => makeSessionStartsDb(ctx.db, ctx.db).delete(convId));
    expect(await row()).toBeNull();
  });

  test("the sessions reader counts rollup rows the team can see, by agent, without hidden members", async () => {
    const { t, owner, outsider, team } = await setup();
    const now = Date.now();
    await t.run(async (ctx) => {
      const hidden = await ctx.db.insert("users", { name: "Quiet" } as any);
      await ctx.db.insert("team_memberships", { user_id: hidden, team_id: team, role: "member", joined_at: 1, visibility: "hidden" } as any);
      const add = (user_id: any, agent_type: string, extra: Record<string, unknown> = {}) =>
        ctx.db.insert("session_starts", { conversation_id: undefined as any, user_id, agent_type, started_at: now - 1000, subagent: false, visible_team_id: team, ...extra } as any);
      await add(owner, "claude_code");
      await add(owner, "codex");
      await add(owner, "codex", { subagent: true });
      await add(owner, "codex", { visible_team_id: undefined });
      await add(hidden, "codex");
      await add(outsider, "codex", { visible_team_id: undefined });
      // A start stamped in the future (microseconds read as ms) is past any date.
      await add(owner, "cursor", { started_at: now * 1000 });
    });
    const page = await t.query(internal.pageData.readPage, {
      owner, workspace: `team:${team}`, reader: "sessions", args_json: JSON.stringify({ days: 1, group_by: "agent", subagents: false }), cursor: null, now,
    });
    expect(page.items.map((i: unknown[]) => i[1]).sort()).toEqual(["claude_code", "codex"]);
    expect(page.scanned).toBe(4);
  });
});

describe("the waiting reader", () => {
  test("validates its window and says what it reads", () => {
    expect(PAGE_READERS.waiting.validate({})).toMatchObject({ args: { days: 7 }, text: expect.stringContaining("sessions that need input") });
    expect(PAGE_READERS.waiting.validate({ days: 31 })).toEqual({ error: '"days" must be a whole number from 1 to 30' });
    expect(PAGE_READERS.waiting.validate({ kind: "task" })).toMatchObject({ error: expect.stringContaining('unknown arg "kind"') });
  });

  // Pat's queue: a session parked on Pat, one that holds an open decision, a
  // finished one, a private one; a decision handed over from a teammate's
  // session; tasks in review, blocked, plain in progress and in another workspace.
  async function queue() {
    const ctx = await setup();
    const { t, owner, outsider, team } = ctx;
    const now = Date.now();
    const ids = await t.run(async (c) => {
      const mate = await c.db.insert("users", { name: "Mate" } as any);
      await c.db.insert("team_memberships", { user_id: mate, team_id: team, role: "member", joined_at: 1 } as any);
      const conv = (title: string, extra: Record<string, unknown> = {}, user = owner) =>
        c.db.insert("conversations", {
          user_id: user, team_id: team, is_private: false, agent_type: "claude_code", started_at: now - 60_000, status: "active",
          message_count: 4, updated_at: now - 5_000, title, inbox_rest: "needs_input", inbox_rest_at: now, ...extra,
        } as any);
      const parked = await conv("Parked on Pat", { thread_state: "Needs a prod key\nmore detail" });
      const asking = await conv("Asking Pat", { updated_at: now - 4_000 });
      await conv("Finished", { inbox_rest: "done" });
      await conv("Private ask", { is_private: true });
      await conv("Stashed ask", { inbox_stashed_at: now - 1_000 });
      await conv("Old ask", { updated_at: now - 10 * 86_400_000, inbox_rest_at: now - 10 * 86_400_000 });
      await conv("Outsider ask", {}, outsider);
      const matesConv = await conv("Mate's run", {}, mate);
      const decide = (conversation_id: any, user_id: any, short_id: string, question: string, extra: Record<string, unknown> = {}) =>
        c.db.insert("session_decisions", {
          conversation_id, session_id: "s", user_id, short_id, question, options: [{ label: "A" }, { label: "B" }], blocking: true, status: "pending", created_at: now - 3_000, ...extra,
        } as any);
      await decide(asking, owner, "sd-1", "Ship the schema change?");
      const handed = await decide(matesConv, mate, "sd-2", "Which icon?", { asked_user_ids: [owner], created_at: now - 2_000 });
      await c.db.insert("decision_inbox", { decision_id: handed, user_id: owner, status: "pending", created_at: now - 2_000 });
      const matesSecret = await conv("Mate's secret run", { is_private: true }, mate);
      const handedPrivately = await decide(matesSecret, mate, "sd-4", "Rename the repo?", { asked_user_ids: [owner], created_at: now - 2_500 });
      await c.db.insert("decision_inbox", { decision_id: handedPrivately, user_id: owner, status: "pending", created_at: now - 2_500 });
      await decide(asking, owner, "sd-3", "Already answered", { status: "answered", resolved_at: now - 1_000 });
      const task = (short_id: string, status: string, extra: Record<string, unknown> = {}) =>
        c.db.insert("tasks", {
          user_id: owner, short_id, title: `Task ${short_id}`, task_type: "task", status, priority: "medium", source: "human",
          assignee: String(owner), workspace: `team:${team}`, created_at: now - 9_000, updated_at: now - 1_000, ...extra,
        } as any);
      await task("ct-1", "in_review");
      await task("ct-2", "in_progress", { execution_status: "blocked" });
      await task("ct-3", "in_progress");
      await task("ct-4", "in_review", { workspace: `user:${owner}` });
      await task("ct-5", "in_review", { assignee: String(mate) });
      return { parked, asking };
    });
    return { ...ctx, ...ids, now };
  }

  async function readAll(t: any, owner: any, workspace: string, now: number) {
    const items: unknown[][] = [];
    let cursor: string | null = null;
    do {
      const page: { items: unknown[][]; cursor: string | null } = await t.query(internal.pageData.readPage, { owner, workspace, reader: "waiting", args_json: JSON.stringify({ days: 7 }), cursor, now });
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== null);
    return PAGE_READERS.waiting.fold!(items, { days: 7 }, now);
  }

  test("a team page lists the team-visible sessions that need Pat, the decisions asked of Pat and Pat's tasks waiting on review or blocked", async () => {
    const { t, owner, team, parked, now } = await queue();
    const table = await readAll(t, owner, `team:${team}`, now);
    expect(table.columns).toEqual(["kind", "ref", "title", "detail", "since", "url"]);
    // Newest first; the session holding sd-1 shows once, as its decision.
    expect(table.rows.map((r) => [r[0], r[1], r[2], r[3]])).toEqual([
      ["task", "ct-1", "Task ct-1", "in review"],
      ["task", "ct-2", "Task ct-2", "blocked"],
      ["decision", "sd-2", "Which icon?", "Mate's run"],
      ["decision", "sd-1", "Ship the schema change?", "Asking Pat"],
      ["session", String(parked).slice(0, 7), "Parked on Pat", "Needs a prod key"],
    ]);
    const urls = Object.fromEntries(table.rows.map((r) => [r[1], r[5]]));
    expect(urls["ct-1"]).toBe("https://codecast.sh/tasks/ct-1");
    expect(urls["sd-2"]).toBe("https://codecast.sh/decisions/sd-2");
    expect(urls[String(parked).slice(0, 7)]).toBe(`https://codecast.sh/conversation/${parked}`);
    expect(table.rows.at(-1)![4]).toBe(new Date(now - 5_000).toISOString());
  });

  test("a personal page adds Pat's private sessions and personal tasks, and leaves the team's tasks out", async () => {
    const { t, owner, now } = await queue();
    const table = await readAll(t, owner, `user:${owner}`, now);
    expect(table.rows.map((r) => r[2]).sort()).toEqual(["Parked on Pat", "Private ask", "Rename the repo?", "Ship the schema change?", "Task ct-4", "Which icon?"].sort());
    // A card handed over from a teammate's private session shows its question, never that session's title.
    expect(table.rows.find((r) => r[1] === "sd-4")![3]).toBe("");
    expect(JSON.stringify(table.rows)).not.toContain("Mate's secret run");
  });
});
