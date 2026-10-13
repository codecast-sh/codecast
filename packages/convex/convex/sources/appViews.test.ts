import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "../schema";
import { makeFakeDb, schemaIndexes } from "../testDb";
import * as ingest from "../ingest";
import * as tokenConnectors from "../tokenConnectors";
import * as app from "./app";
import * as appViews from "./appViews";
import { encryptConnectionSecret } from "../tokenConnectors";

const h = (fn: any) => fn._handler;
const KEY = "test-connection-secrets-key";
const BASE = "https://api.union.example/v1";
const ADMIN = "https://admin.union.example";
const CONTACT = "2b7c1d5e-9f3a-4c61-8e2d-0a1b2c3d4e5f";

const VIEWS = [
  { name: "conversation", title: "Conversation", path: "/embed/conversation", params: ["at"] },
  { name: "call", title: "Call", path: "/embed/call", params: [] },
];
const MANIFEST = {
  name: "Union",
  version: "8",
  readers: [],
  actions: [
    {
      name: "views.token",
      method: "POST",
      path: "/codecast/views/token",
      input: { type: "object", properties: { view: { type: "string" }, id: { type: "string" }, at: { type: "string" } }, required: ["view", "id"] },
      idempotent: true,
      risk: "low",
    },
  ],
  watches: [],
  views: VIEWS,
};

const MODULES: Record<string, Record<string, any>> = { "sources/app": app, "sources/appViews": appViews, ingest, tokenConnectors };
function lookup(ref: any) {
  const [mod, name] = getFunctionName(ref).split(":");
  const fn = MODULES[mod]?.[name];
  if (!fn) throw new Error(`test world has no ${mod}:${name}`);
  return fn;
}

type Call = { url: string; init: RequestInit };

async function world(opts: { manifest?: unknown; token?: (call: Call) => Response } = {}) {
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
      app_manifests: [],
      conversations: [],
      app_installations: [
        {
          _id: "ai_app",
          provider: "app",
          team_id: "team_1",
          connected_by: "u1",
          access_token_enc: await encryptConnectionSecret("cc_app_SECRET", KEY),
          config: { base_url: BASE },
          granted_scopes: [],
          created_at: 1,
          updated_at: 1,
        },
      ],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async () => undefined };
  const inner = (userId?: string) => ({ db, scheduler, auth: { getUserIdentity: async () => (userId ? { subject: `${userId}|sess` } : null) } }) as any;
  const actionCtx = (userId?: string) =>
    ({ runQuery: (ref: any, args: any) => h(lookup(ref))(inner(userId), args), runMutation: (ref: any, args: any) => h(lookup(ref))(inner(userId), args), scheduler }) as any;
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = url.split("?")[0];
    if (init.method === "GET" && path === `${BASE}/codecast/manifest`) return Response.json(opts.manifest ?? MANIFEST);
    if (init.method === "POST" && path === `${BASE}/codecast/views/token`) {
      return (opts.token ?? (() => Response.json({ url: `${ADMIN}/embed/conversation?token=t0k`, token: "t0k", expires_at: "2026-10-12T10:10:00Z" })))({ url, init });
    }
    return new Response("no route", { status: 404 });
  };
  const { source } = await h(ingest.createSource)(inner("u1"), { workspace: "team", team_id: "team_1", name: "union", provider: "app", promote: ["check_failed"] });
  await app.refreshManifestFor(actionCtx("u1"), source, "ai_app", fetchImpl);
  return { db, inner, actionCtx, calls, fetchImpl, source };
}

const TEAM = { workspace: "team" as const, team_id: "team_1" as any };
const mint = (w: Awaited<ReturnType<typeof world>>, ref: string, user = "u1", workspace: string | null = "team:team_1") => appViews.mintProductView(w.actionCtx(user), { ref, ...(workspace ? { workspace } : {}) }, w.fetchImpl);

beforeEach(() => {
  process.env.CONNECTION_SECRETS_KEY = KEY;
});
afterEach(() => {
  delete process.env.CONNECTION_SECRETS_KEY;
});

describe("minting a product view", () => {
  test("a granted app answers a frame url for the reference; the call is audited with no body", async () => {
    const w = await world();
    await h(app.grant)(w.inner("u1"), { ...TEAM, source: "union", action: "views.token" });
    const out = await mint(w, `union:conversation/${CONTACT}@2026-10-09T14:03:00Z`);
    expect(out).toEqual({
      ok: true,
      app: "Union",
      view: "conversation",
      title: "Conversation",
      url: `${ADMIN}/embed/conversation?token=t0k`,
      origin: ADMIN,
      expires_at: "2026-10-12T10:10:00Z",
    });
    const sent = w.calls.find((c) => c.url.endsWith("/codecast/views/token"))!;
    expect(JSON.parse(String(sent.init.body))).toEqual({ view: "conversation", id: CONTACT, at: "2026-10-09T14:03:00Z" });
    const audit = await w.db.query("app_calls").collect();
    expect(audit.map((r: any) => [r.kind, r.name, r.status])).toEqual([["do", "views.token", "ok"]]);
    expect(JSON.stringify(audit)).not.toContain("t0k");
  });

  test("without a grant the mint is denied and names the grant page; the app is never asked", async () => {
    const w = await world();
    const out = await mint(w, `union:call/${CONTACT}`);
    expect(out).toMatchObject({ ok: false, app: "Union", view: "call", grant_url: expect.stringContaining(w.source.short_id) });
    expect(w.calls.some((c) => c.url.endsWith("/codecast/views/token"))).toBe(false);
  });

  test("an app with no views, an undeclared view, an unknown app or a bad ref answer null", async () => {
    const bare = await world({ manifest: { ...MANIFEST, views: [] } });
    expect(await mint(bare, `union:conversation/${CONTACT}`)).toBeNull();
    const w = await world();
    expect(await mint(w, `union:match/${CONTACT}`)).toBeNull();
    expect(await mint(w, `acme:conversation/${CONTACT}`)).toBeNull();
    expect(await mint(w, "not a ref")).toBeNull();
  });

  test("a reference named by a moment's source reaches the app it reports for", async () => {
    const w = await world();
    await h(app.grant)(w.inner("u1"), { ...TEAM, source: "union", action: "views.token" });
    await h(ingest.createSource)(w.inner("u1"), { ...TEAM, name: "union-moments", provider: "sdk", promote: [] });
    expect(await mint(w, `union-moments:conversation/${CONTACT}`)).toMatchObject({ ok: true, app: "Union" });
    // A view the app does not declare still answers nothing.
    expect(await mint(w, `union-moments:match/${CONTACT}`)).toBeNull();
  });

  test("viewSourceFor: a fingerprint prefix picks the app; two apps in the workspace with the view are ambiguous", () => {
    const m = (name: string) => ({ name, version: "1", readers: [], actions: [], watches: [], views: VIEWS });
    const appRow = (name: string) => ({ name, status: "active" as const, provider: "app", workspace: "team:t", manifest: m(name) });
    const moments = { name: "union-moments", status: "active" as const, provider: "sdk", workspace: "team:t", manifest: null };
    expect(appViews.viewSourceFor([appRow("acme"), appRow("union"), moments], "union-moments", "call")).toBeNull();
    expect(appViews.viewSourceFor([appRow("acme"), appRow("union"), { ...moments, fingerprint_prefix: "union" }], "union-moments", "call")).toMatchObject({ index: 1 });
    expect(appViews.viewSourceFor([appRow("union"), moments], "union-moments", "call")).toMatchObject({ index: 0 });
    expect(appViews.viewSourceFor([{ ...appRow("union"), status: "paused" as const }], "union", "call")).toBeNull();
  });

  test("viewSourceFor: a source's records reach the app in its own workspace, never a same-named app in another", () => {
    const m = (name: string) => ({ name, version: "1", readers: [], actions: [], watches: [], views: VIEWS });
    const appIn = (workspace: string) => ({ name: "union", status: "active" as const, provider: "app", workspace, manifest: m("union") });
    const moments = { name: "union-moments", status: "active" as const, provider: "sdk", workspace: "team:a", fingerprint_prefix: "union", manifest: null };
    // The personal app is listed first; team A's moments still mint through team A's app.
    expect(appViews.viewSourceFor([appIn("user:u"), appIn("team:b"), appIn("team:a"), moments], "union-moments", "call")).toMatchObject({ index: 2 });
    expect(appViews.viewSourceFor([appIn("user:u"), appIn("team:b"), moments], "union-moments", "call")).toBeNull();
  });

  test("a mint reaches only the workspace it names: another of the caller's workspaces never answers, and its app is never called", async () => {
    const w = await world();
    await h(app.grant)(w.inner("u1"), { ...TEAM, source: "union", action: "views.token" });
    const asked = () => w.calls.filter((c) => c.url.endsWith("/codecast/views/token")).length;
    // The team holds the granted app named union. From the caller's personal workspace the same reference finds nothing.
    expect(await mint(w, `union:conversation/${CONTACT}`, "u1", "user:u1")).toBeNull();
    // A workspace that is not the caller's, and no workspace at all, answer nothing.
    expect(await mint(w, `union:conversation/${CONTACT}`, "u1", "team:team_other")).toBeNull();
    expect(await mint(w, `union:conversation/${CONTACT}`, "u1", null)).toBeNull();
    expect(asked()).toBe(0);
    expect(await w.db.query("app_calls").collect()).toEqual([]);
    expect(await mint(w, `union:conversation/${CONTACT}`, "u1", "team:team_1")).toMatchObject({ ok: true, app: "Union" });
    expect(asked()).toBe(1);
  });

  test("someone outside the workspace finds no source", async () => {
    const w = await world();
    await h(app.grant)(w.inner("u1"), { ...TEAM, source: "union", action: "views.token" });
    expect(await mint(w, `union:conversation/${CONTACT}`, "u2")).toBeNull();
  });

  test("a url off the declared path or not https is refused", async () => {
    const off = await world({ token: () => Response.json({ url: `${ADMIN}/admin/contacts?token=x`, token: "x" }) });
    await h(app.grant)(off.inner("u1"), { ...TEAM, source: "union", action: "views.token" });
    expect(await mint(off, `union:conversation/${CONTACT}`)).toMatchObject({ ok: false, error: expect.stringContaining("/embed/conversation") });
    const plain = await world({ token: () => Response.json({ url: "http://admin.union.example/embed/conversation?token=x", token: "x" }) });
    await h(app.grant)(plain.inner("u1"), { ...TEAM, source: "union", action: "views.token" });
    expect(await mint(plain, `union:conversation/${CONTACT}`)).toMatchObject({ ok: false, error: "the app's url is not https" });
  });

  test("a url on a host that is not the app's site is refused, whatever its path", async () => {
    const foreign = await world({ token: () => Response.json({ url: "https://anything.example/embed/conversation?token=x", token: "x" }) });
    await h(app.grant)(foreign.inner("u1"), { ...TEAM, source: "union", action: "views.token" });
    expect(await mint(foreign, `union:conversation/${CONTACT}`)).toMatchObject({ ok: false, error: "the app's url is not on union.example" });
    expect(appViews.siteOf("admin.union.example")).toBe("union.example");
    expect(appViews.siteOf("app.acme.co.uk")).toBe("acme.co.uk");
    expect(appViews.siteOf("localhost")).toBe("localhost");
  });
});

describe("readViewToken", () => {
  test("localhost may be http; a missing expiry gets a short one", () => {
    const out = appViews.readViewToken(JSON.stringify({ url: "http://localhost:5173/embed/call?token=a" }), { path: "/embed/call" });
    expect(out).toMatchObject({ url: "http://localhost:5173/embed/call?token=a", origin: "http://localhost:5173" });
    expect(appViews.readViewToken("<html>", { path: "/x" })).toEqual({ error: "the app's answer is not JSON" });
  });

  test("a url on codecast's own site is refused, whatever base url the connection names", () => {
    // A connection whose base url is codecast.sh, declaring a published page's path: same site as the app around the frame.
    const own = JSON.stringify({ url: "https://codecast.sh/a/slug" });
    expect(appViews.readViewToken(own, { path: "/a/slug" }, "https://codecast.sh", "https://codecast.sh")).toEqual({ error: "the app's url is on codecast's own site, which is never framed here" });
    expect(appViews.readViewToken(JSON.stringify({ url: "https://pages.codecast.sh/a/slug" }), { path: "/a/slug" }, "https://codecast.sh", "https://codecast.sh")).toMatchObject({ error: expect.stringContaining("own site") });
    // Another site frames as before; on loopback only the exact origin is codecast's.
    expect(appViews.readViewToken(JSON.stringify({ url: "https://admin.union.example/embed/call" }), { path: "/embed/call" }, "https://union.example", "https://codecast.sh")).toMatchObject({ origin: "https://admin.union.example" });
    expect(appViews.readViewToken(JSON.stringify({ url: "http://localhost:5173/embed/call" }), { path: "/embed/call" }, "http://localhost:5173", "http://localhost:3201")).toMatchObject({ origin: "http://localhost:5173" });
    expect(appViews.readViewToken(JSON.stringify({ url: "http://localhost:3201/embed/call" }), { path: "/embed/call" }, "http://localhost:3201", "http://localhost:3201")).toMatchObject({ error: expect.stringContaining("own site") });
  });
});
