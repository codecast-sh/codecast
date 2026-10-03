import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "../schema";
import { makeFakeDb, schemaIndexes } from "../testDb";
import * as ingest from "../ingest";
import * as tokenConnectors from "../tokenConnectors";
import * as app from "./app";
import { encryptConnectionSecret } from "../tokenConnectors";
import { hashToken } from "../apiTokens";

const h = (fn: any) => fn._handler;
const KEY = "test-connection-secrets-key";
const SECRET = "cc_app_SECRET_123";
const BASE = "https://api.union.example/v1";

const MANIFEST = {
  name: "Union",
  version: "7",
  readers: [
    { name: "history.timeline", title: "Timeline", method: "GET", path: "/codecast/history/{contact_id}", input: { type: "object", properties: { contact_id: { type: "string" }, limit: { type: "integer", maximum: 50 } }, required: ["contact_id"] } },
    { name: "invariants.list", method: "GET", path: "/codecast/invariants" },
    { name: "jobs.failed", method: "GET", path: "/codecast/jobs/failed" },
  ],
  actions: [
    { name: "jobs.rerun", method: "POST", path: "/codecast/jobs/{id}/rerun", input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, idempotent: true, risk: "low" },
    { name: "jobs.cancel", method: "POST", path: "/codecast/jobs/{id}/cancel", input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, risk: "high" },
  ],
  watches: [
    { reader: "invariants.list", every: "5m", kind: "check", map: { id: "key", ok: "ok", title: "name" } },
    { reader: "jobs.failed", every: "5m", kind: "job", map: { id: "id", ok: "ok", title: "job", detail: "error", at: "at" } },
  ],
};

// Every module whose functions an action reaches through runQuery/runMutation.
const MODULES: Record<string, Record<string, any>> = { "sources/app": app, ingest, tokenConnectors };
function lookup(ref: any) {
  const [mod, name] = getFunctionName(ref).split(":");
  const fn = MODULES[mod]?.[name];
  if (!fn) throw new Error(`test world has no ${mod}:${name}`);
  return fn;
}

type Call = { url: string; init: RequestInit };

async function world(opts: { manifest?: unknown; routes?: Record<string, (call: Call) => Response | Promise<Response>> } = {}) {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db: any = makeFakeDb(
    {
      users: [{ _id: "u1", email: "ada@acme.io", active_team_id: "team_1" }, { _id: "u2", email: "eve@else.io" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      counters: [],
      projects: [],
      event_sources: [],
      event_groups: [],
      event_samples: [],
      external_events: [],
      agent_tasks: [],
      replays: [],
      app_calls: [],
      conversations: [{ _id: "c1", session_id: "sess-1", user_id: "u1", short_id: "jx7abcd", team_id: "team_1", is_private: false }],
      app_installations: [
        {
          _id: "ai_app",
          provider: "app",
          team_id: "team_1",
          connected_by: "u1",
          access_token_enc: await encryptConnectionSecret(SECRET, KEY),
          config: { base_url: BASE },
          granted_scopes: [],
          created_at: 1,
          updated_at: 1,
        },
      ],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const inner = (userId?: string) =>
    ({ db, scheduler, auth: { getUserIdentity: async () => (userId ? { subject: `${userId}|sess` } : null) } }) as any;
  // An action's ctx: runQuery/runMutation carry the caller's identity, like Convex does.
  const actionCtx = (userId?: string) =>
    ({
      runQuery: (ref: any, args: any) => h(lookup(ref))(inner(userId), args),
      runMutation: (ref: any, args: any) => h(lookup(ref))(inner(userId), args),
      scheduler,
    }) as any;

  const calls: Call[] = [];
  const routes: Record<string, (call: Call) => Response | Promise<Response>> = {
    [`GET ${BASE}/codecast/manifest`]: () => Response.json(opts.manifest ?? MANIFEST),
    ...opts.routes,
  };
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const route = routes[`${init.method} ${url.split("?")[0]}`];
    if (!route) return new Response("no route", { status: 404 });
    return route(call);
  };

  const { source } = await h(ingest.createSource)(inner("u1"), { workspace: "team", team_id: "team_1", name: "union", provider: "app", promote: ["check_failed"] });
  return { db, scheduled, inner, actionCtx, calls, fetchImpl, source };
}

const TEAM = { workspace: "team" as const, team_id: "team_1" as any };
const header = (call: Call, name: string) => new Headers(call.init.headers as any).get(name);

beforeEach(() => {
  process.env.CONNECTION_SECRETS_KEY = KEY;
});
afterEach(() => {
  delete process.env.CONNECTION_SECRETS_KEY;
});

describe("manifest", () => {
  test("the first call fetches and caches it with the bearer secret", async () => {
    const w = await world({ routes: { [`GET ${BASE}/codecast/history/c%2F9`]: () => Response.json({ rows: [{ $kind: "email" }] }) } });
    const out = await app.appCall(w.actionCtx("u1"), "read", { ...TEAM, source: "union", name: "history.timeline", args_json: '{"contact_id":"c/9","limit":3}' }, w.fetchImpl);
    expect(out).toMatchObject({ ok: true, status: 200, text: '{"rows":[{"$kind":"email"}]}' });
    expect(w.calls.map((c) => c.url)).toEqual([`${BASE}/codecast/manifest`, `${BASE}/codecast/history/c%2F9?limit=3`]);
    for (const c of w.calls) expect(header(c, "authorization")).toBe(`Bearer ${SECRET}`);
    const row = w.db._tables.event_sources[0];
    expect(JSON.parse(row.manifest_json).readers).toHaveLength(3);
    expect(row.manifest_fetched_at).toBeGreaterThan(0);

    // A fresh cache is not refetched.
    await app.appCall(w.actionCtx("u1"), "read", { ...TEAM, source: "union", name: "history.timeline", args_json: '{"contact_id":"x"}' }, w.fetchImpl);
    expect(w.calls.filter((c) => c.url.endsWith("/manifest"))).toHaveLength(1);
  });

  test("a bad manifest is refused with its reasons; a good cached one survives an outage", async () => {
    const w = await world({ manifest: { name: "x", readers: [{ name: "run.sql", path: "/sql" }] } });
    const out = await app.refreshManifestFor(w.actionCtx("u1"), w.source, "ai_app", w.fetchImpl);
    expect(out.ok).toBe(false);
    expect((out as any).error).toContain("raw SQL is never a reader");
    expect(w.db._tables.event_sources[0]).toMatchObject({ status: "error" });

    const ok = await world();
    await app.refreshManifestFor(ok.actionCtx("u1"), ok.source, "ai_app", ok.fetchImpl);
    const down = async () => new Response("down", { status: 503 });
    await app.refreshManifestFor(ok.actionCtx("u1"), ok.source, "ai_app", down as any);
    const row = ok.db._tables.event_sources[0];
    expect(row.manifest_json).toBeTruthy();
    expect(row.status).toBe("active");
    expect(row.last_error).toContain("answered 503");
  });

  test("capabilities never carry the secret and name grants in force", async () => {
    const w = await world();
    await app.refreshManifestFor(w.actionCtx("u1"), w.source, "ai_app", w.fetchImpl);
    await h(app.grant)(w.inner("u1"), { ...TEAM, source: "union", action: "jobs.rerun" });
    const caps = await h(app.capabilities)(w.inner("u1"), { ...TEAM, source: "union" });
    expect(caps.grants.map((g: any) => g.action)).toEqual(["jobs.rerun"]);
    expect(JSON.parse(caps.manifest_json).actions).toHaveLength(2);
    expect(JSON.stringify(caps)).not.toContain(SECRET);
    expect(JSON.stringify(caps)).not.toContain(w.db._tables.app_installations[0].access_token_enc);
  });
});

describe("read", () => {
  test("args are checked against the declared schema before any call", async () => {
    const w = await world();
    const out = await app.appCall(w.actionCtx("u1"), "read", { ...TEAM, source: "union", name: "history.timeline", args_json: '{"limit":99}' }, w.fetchImpl);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("args.contact_id: required");
    expect(out.error).toContain("args.limit: must be at most 50");
    expect(w.calls.filter((c) => !c.url.endsWith("/manifest"))).toHaveLength(0);
    expect(w.db._tables.app_calls[0]).toMatchObject({ kind: "read", name: "history.timeline", status: "error", user_id: "u1" });
  });

  test("an unknown reader lists the declared ones", async () => {
    const w = await world();
    const out = await app.appCall(w.actionCtx("u1"), "read", { ...TEAM, source: "union", name: "contacts.dump" }, w.fetchImpl);
    expect(out.error).toContain("declares no reader contacts.dump (it has: history.timeline, invariants.list, jobs.failed)");
  });

  test("the actor header names the person and session; the audit stores no body", async () => {
    const w = await world({ routes: { [`GET ${BASE}/codecast/history/c1`]: () => Response.json({ secret_row: "PII" }) } });
    await app.appCall(w.actionCtx("u1"), "read", { ...TEAM, conversation_id: "sess-1", source: "union", name: "history.timeline", args_json: '{"contact_id":"c1"}' }, w.fetchImpl);
    const call = w.calls.at(-1)!;
    expect(header(call, "x-codecast-actor")).toBe("person=ada@acme.io; session=jx7abcd");
    expect(header(call, "idempotency-key")).toBeNull();
    const audit = w.db._tables.app_calls[0];
    expect(audit).toMatchObject({ status: "ok", http_status: 200, conversation_id: "c1", workspace: "team:team_1" });
    expect(audit.args_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(audit)).not.toContain("PII");
  });

  test("a response over 256 KB is refused; a hang is cut off", async () => {
    const big = "x".repeat(300 * 1024);
    const w = await world({ routes: { [`GET ${BASE}/codecast/history/c1`]: () => new Response(big) } });
    const out = await app.appCall(w.actionCtx("u1"), "read", { ...TEAM, source: "union", name: "history.timeline", args_json: '{"contact_id":"c1"}' }, w.fetchImpl);
    expect(out).toMatchObject({ ok: false, error: "the response is over 256 KB" });
    expect(w.db._tables.app_calls[0]).toMatchObject({ status: "error", bytes: 256 * 1024 });

    const timeout = await app.appHttp(
      async (_u, init) => {
        expect(init.signal).toBeTruthy();
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
      { url: `${BASE}/x`, method: "GET" },
      { token: SECRET, actor: "" },
    );
    expect(timeout).toMatchObject({ ok: false, error: "no answer in 15s" });
  });

  test("a redirect is not followed, so the secret never reaches another host", async () => {
    const w = await world({ routes: { [`GET ${BASE}/codecast/history/c1`]: () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) } });
    const out = await app.appCall(w.actionCtx("u1"), "read", { ...TEAM, source: "union", name: "history.timeline", args_json: '{"contact_id":"c1"}' }, w.fetchImpl);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("does not follow redirects");
    expect(w.calls.every((c) => c.url.startsWith(BASE))).toBe(true);
    expect(w.calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  test("someone outside the workspace cannot call it", async () => {
    const w = await world();
    await expect(app.appCall(w.actionCtx("u2"), "read", { workspace: "personal", source: w.source.short_id, name: "history.timeline" }, w.fetchImpl)).rejects.toThrow(/not found/);
    expect(w.calls).toHaveLength(0);
  });
});

describe("do", () => {
  const rerun = (w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown> = {}) =>
    app.appCall(w.actionCtx("u1"), "do", { ...TEAM, source: "union", name: "jobs.rerun", args_json: '{"id":"j1"}', ...extra }, w.fetchImpl);

  test("an ungranted action is denied and audited, and never called", async () => {
    const w = await world({ routes: { [`POST ${BASE}/codecast/jobs/j1/rerun`]: () => Response.json({ ok: true }) } });
    const out = await rerun(w);
    expect(out).toMatchObject({ ok: false, denied: true });
    expect(out.error).toContain("cast connector grant <source> jobs.rerun");
    expect(w.calls.some((c) => c.url.includes("/rerun"))).toBe(false);
    expect(w.db._tables.app_calls[0]).toMatchObject({ kind: "do", status: "denied" });
  });

  test("a grant lets it run; the grant records who and how, and expires", async () => {
    const w = await world({ routes: { [`POST ${BASE}/codecast/jobs/j1/rerun`]: () => Response.json({ ok: true }) } });
    await app.refreshManifestFor(w.actionCtx("u1"), w.source, "ai_app", w.fetchImpl);
    const { grant } = await h(app.grant)(w.inner("u1"), { ...TEAM, source: "union", action: "jobs.rerun", until: "1h" });
    expect(grant).toMatchObject({ action: "jobs.rerun", granted_by: "u1", via: "session" });
    expect(grant.until - grant.granted_at).toBe(3600_000);
    const out = await rerun(w);
    expect(out).toMatchObject({ ok: true, status: 200 });
    const call = w.calls.at(-1)!;
    expect(call.init.body).toBe("{}");
    expect(header(call, "content-type")).toBe("application/json");

    w.db._tables.event_sources[0].grants[0].until = Date.now() - 1;
    expect((await rerun(w)).denied).toBe(true);

    await h(app.revoke)(w.inner("u1"), { ...TEAM, source: "union", action: "jobs.rerun" });
    expect(w.db._tables.event_sources[0].grants).toEqual([]);
  });

  test("a high-risk, non-idempotent action needs yes and a key per call; the key is sent", async () => {
    const w = await world({ routes: { [`POST ${BASE}/codecast/jobs/j1/cancel`]: () => Response.json({ ok: true }) } });
    await app.refreshManifestFor(w.actionCtx("u1"), w.source, "ai_app", w.fetchImpl);
    await h(app.grant)(w.inner("u1"), { ...TEAM, source: "union", action: "jobs.cancel" });
    const cancel = (extra: Record<string, unknown>) =>
      app.appCall(w.actionCtx("u1"), "do", { ...TEAM, source: "union", name: "jobs.cancel", args_json: '{"id":"j1"}', ...extra }, w.fetchImpl);
    expect((await cancel({ idempotency_key: "k1" })).error).toContain("--yes");
    expect((await cancel({ yes: true })).error).toContain("idempotency key");
    expect(await cancel({ yes: true, idempotency_key: "k1" })).toMatchObject({ ok: true });
    expect(header(w.calls.at(-1)!, "idempotency-key")).toBe("k1");
    expect(w.db._tables.app_calls.map((c: any) => c.status)).toEqual(["denied", "denied", "ok"]);
  });

  test("a grant from the CLI token records via api_token; an undeclared action cannot be granted", async () => {
    const w = await world();
    await app.refreshManifestFor(w.actionCtx("u1"), w.source, "ai_app", w.fetchImpl);
    w.db._tables.api_tokens = [{ _id: "tok1", user_id: "u1", token_hash: await hashToken("cli-token") }];
    await expect(h(app.grant)(w.inner(), { ...TEAM, source: "union", action: "db.drop", api_token: "cli-token" })).rejects.toThrow(/declares no action db.drop/);
    await expect(h(app.grant)(w.inner(), { ...TEAM, source: "union", action: "jobs.rerun", until: "soon", api_token: "cli-token" })).rejects.toThrow(/not a duration/);
    const viaToken = await h(app.grant)(w.inner(), { ...TEAM, source: "union", action: "jobs.rerun", api_token: "cli-token" });
    expect(viaToken.grant).toMatchObject({ granted_by: "u1", via: "api_token" });
    await expect(h(app.grant)(w.inner(), { ...TEAM, source: "union", action: "jobs.rerun", api_token: "forged" })).rejects.toThrow();
  });

  test("a grant before the manifest is fetched asks for a refresh", async () => {
    const w = await world();
    await expect(h(app.grant)(w.inner("u1"), { ...TEAM, source: "union", action: "jobs.rerun" })).rejects.toThrow(/cast connector refresh union/);
  });
});

describe("watches", () => {
  test("a polled reader's rows become check and job groups whose flips fire", async () => {
    let invariants = [{ key: "inv-orphans", ok: false, name: "Orphan calls" }, { key: "inv-dupes", ok: true, name: "No dupes" }];
    const now = Date.now();
    const jobs = [{ id: "run-1", ok: false, job: "sendEmails", error: "timeout", at: new Date(now - 60_000).toISOString() }];
    const w = await world({
      routes: {
        [`GET ${BASE}/codecast/invariants`]: () => Response.json(invariants),
        [`GET ${BASE}/codecast/jobs/failed`]: () => Response.json({ rows: jobs }),
      },
    });
    await app.refreshManifestFor(w.actionCtx("u1"), w.source, "ai_app", w.fetchImpl);
    expect(await h(app.sourcesWithDueWatches)(w.inner(), { now })).toEqual([w.source._id]);

    const first = await app.pollSourceWatches(w.actionCtx(), w.source._id, w.fetchImpl, now);
    expect(first).toEqual({ polled: 2, accepted: 3 });
    const groups = w.db._tables.event_groups;
    expect(groups.map((g: any) => [g.kind, g.title, g.status]).sort()).toEqual([
      // A green check is resolved from its first report; only red announces.
      ["check", "No dupes", "resolved"],
      ["check", "Orphan calls", "open"],
      ["job", "sendEmails", "open"],
    ].sort());
    const kinds = () => w.db._tables.external_events.map((e: any) => e.kind).sort();
    expect(kinds()).toEqual(["check_failed", "job_failed"]);
    expect(w.scheduled.filter((s) => s.name === "ingest:promote")).toHaveLength(1);
    for (const c of w.calls.filter((c) => !c.url.endsWith("/manifest"))) {
      expect(header(c, "x-codecast-actor")).toMatch(/^watch=(check|job):/);
    }

    // Not due again until the interval is up.
    expect(await h(app.sourcesWithDueWatches)(w.inner(), { now: now + 60_000 })).toEqual([]);

    // Next poll: the same failed job is not counted again; the invariant recovers.
    invariants = [{ key: "inv-orphans", ok: true, name: "Orphan calls" }, { key: "inv-dupes", ok: true, name: "No dupes" }];
    const later = now + 5 * 60_000;
    await app.pollSourceWatches(w.actionCtx(), w.source._id, w.fetchImpl, later);
    expect(groups.find((g: any) => g.kind === "job").count).toBe(1);
    expect(kinds()).toEqual(["check_failed", "check_recovered", "job_failed"]);
    const state = w.db._tables.event_sources[0].watch_state;
    expect(state.find((s: any) => s.key === "job:jobs.failed").cursor).toBe(now - 60_000);
    expect(w.db._tables.app_calls).toHaveLength(0);
  });

  test("a failing poll records the error on the watch and in the audit, as the owner", async () => {
    const now = Date.now();
    const w = await world({
      routes: {
        [`GET ${BASE}/codecast/invariants`]: () => new Response("boom", { status: 500 }),
        [`GET ${BASE}/codecast/jobs/failed`]: () => Response.json({ nope: true }),
      },
    });
    await app.refreshManifestFor(w.actionCtx("u1"), w.source, "ai_app", w.fetchImpl);
    await app.pollSourceWatches(w.actionCtx(), w.source._id, w.fetchImpl, now);
    const state = w.db._tables.event_sources[0].watch_state;
    expect(state.find((s: any) => s.key === "check:invariants.list").last_error).toBe("answered 500");
    expect(state.find((s: any) => s.key === "job:jobs.failed").last_error).toContain("list of rows");
    expect(w.db._tables.app_calls.map((c: any) => [c.user_id, c.status])).toEqual([["u1", "error"], ["u1", "error"]]);
    expect(w.db._tables.event_groups).toHaveLength(0);
  });

  test("a paused source is not polled", async () => {
    const w = await world();
    await app.refreshManifestFor(w.actionCtx("u1"), w.source, "ai_app", w.fetchImpl);
    w.db._tables.event_sources[0].status = "paused";
    expect(await h(app.sourcesWithDueWatches)(w.inner(), { now: Date.now() })).toEqual([]);
    expect(await app.pollSourceWatches(w.actionCtx(), w.source._id, w.fetchImpl)).toEqual({ polled: 0 });
  });

  test("dueWatches waits out each watch's own interval", () => {
    const parsed = app.cachedManifest({ manifest_json: JSON.stringify({ ...MANIFEST, watches: [{ ...MANIFEST.watches[0], every: "1h" }] }) });
    expect(app.dueWatches(parsed, undefined, 0)).toHaveLength(1);
    expect(app.dueWatches(parsed, [{ key: "check:invariants.list", polled_at: 0 }], 30 * 60_000)).toHaveLength(0);
    expect(app.dueWatches(parsed, [{ key: "check:invariants.list", polled_at: 0 }], 3600_000 - 30_000)).toHaveLength(1);
  });
});
