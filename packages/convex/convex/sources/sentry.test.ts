import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "../schema";
import { makeFakeDb, schemaIndexes } from "../testDb";
import { hex, hmacSha256, verifyHmacHex } from "../lib/hmac";
import { HOUR_MS, hourStart } from "../lib/ingestGroups";
import { applyMirrorBatch, createSource, mirrorGroups } from "../ingest";
import * as sentry from "./sentry";
import {
  SENTRY_POLL,
  issueDetail,
  issueToMirror,
  issuesListUrl,
  nextCursor,
  parseSentryWebhook,
  pollInputs,
  processWebhook,
  readUnresolved,
  replayIdOf,
  sentryOrgFromUrl,
  sentryStatus,
  sentryTarget,
  sentryWebhook,
  setIssueStatus,
  takeWebhook,
  targetReads,
  trimEvent,
  trimFrames,
  type SentryTarget,
} from "./sentry";

// Recorded shapes: the fields Sentry's API and webhooks send, trimmed to what
// the adapter reads plus a few it must ignore. No live token is used here.

const h = (fn: any) => fn._handler;
const NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();
const HOUR = hourStart(NOW);

function listIssue(over: Record<string, unknown> = {}) {
  return {
    id: "4567",
    shortId: "WEB-1A",
    title: "TypeError: Cannot read properties of undefined (reading 'id')",
    culprit: "app/routes/home.tsx in loader",
    permalink: "https://acme.sentry.io/issues/4567/",
    logger: null,
    level: "error",
    status: "unresolved",
    substatus: "new",
    statusDetails: {},
    isPublic: false,
    platform: "javascript",
    project: { id: "11", name: "web", slug: "web", platform: "javascript" },
    type: "error",
    metadata: { type: "TypeError", value: "Cannot read properties of undefined (reading 'id')", filename: "app/routes/home.tsx" },
    numComments: 0,
    assignedTo: null,
    isBookmarked: false,
    isSubscribed: false,
    hasSeen: false,
    annotations: [],
    isUnhandled: true,
    count: "42",
    userCount: 7,
    firstSeen: iso(NOW - 2 * HOUR_MS),
    lastSeen: iso(NOW - 60_000),
    stats: { "24h": [[(HOUR - 2 * HOUR_MS) / 1000, 30], [(HOUR - HOUR_MS) / 1000, 0], [HOUR / 1000, 12]] },
    ...over,
  };
}

const latestEvent = {
  id: "e1",
  eventID: "e1",
  groupID: "4567",
  title: "TypeError: Cannot read properties of undefined (reading 'id')",
  message: "",
  platform: "javascript",
  dateCreated: iso(NOW - 60_000),
  release: { version: "web@1.4.2" },
  user: { id: "user_9", email: "person@example.com", ip_address: "10.0.0.1" },
  contexts: { replay: { replay_id: "a1b2c3d4e5f6" }, browser: { name: "Chrome" } },
  tags: [
    { key: "environment", value: "production" },
    { key: "replayId", value: "a1b2c3d4e5f6" },
  ],
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'id')",
            mechanism: { type: "onerror", handled: false },
            stacktrace: {
              frames: [
                { filename: "node_modules/react-dom/client.js", function: "render", lineNo: 900, colNo: 3, inApp: false, context: [[900, "render()"]] },
                { filename: "app/routes/home.tsx", function: "loader", lineNo: 12, colNo: 20, inApp: true, vars: { secret: "x" }, context: [[11, "const u = await getUser();"], [12, "return u.id;"], [13, "}"]] },
                { filename: "node_modules/lib/index.js", function: "inner", lineNo: 3, colNo: 1, inApp: false },
              ],
            },
          },
        ],
      },
    },
    { type: "request", data: { url: "https://app.acme.dev/home", method: "GET", data: { password: "never" } } },
    { type: "breadcrumbs", data: { values: [{ message: "clicked" }] } },
  ],
};

const TARGET: SentryTarget = { host: "https://sentry.io", org: "acme", projects: [], environments: [] };

describe("parsing", () => {
  test("target comes from the connection and refuses a mismatched or bad org or project", () => {
    expect(sentryTarget({ org: "acme", host: "https://sentry.io" }, { projects: ["web"], environments: ["production"] })).toEqual({
      ok: true,
      target: { host: "https://sentry.io", org: "acme", projects: ["web"], environments: ["production"] },
    });
    expect(sentryTarget({ org: "acme" }, undefined)).toMatchObject({ ok: true, target: { host: "https://sentry.io" } });
    expect(sentryTarget({ org: "acme" }, { org: "other" })).toMatchObject({ ok: false });
    expect(sentryTarget({}, {})).toMatchObject({ ok: false });
    expect(sentryTarget({ org: "acme" }, { projects: ["../evil"] })).toMatchObject({ ok: false });
  });

  test("the list url asks for unresolved issues seen in 24h, newest first, every project by default", () => {
    const url = new URL(issuesListUrl({ ...TARGET, environments: ["production"] }, [], "c1"));
    expect(url.pathname).toBe("/api/0/organizations/acme/issues/");
    expect(url.searchParams.getAll("project")).toEqual(["-1"]);
    expect(url.searchParams.get("environment")).toBe("production");
    expect(url.searchParams.get("query")).toBe("is:unresolved");
    expect(url.searchParams.get("sort")).toBe("date");
    expect(url.searchParams.get("statsPeriod")).toBe("24h");
    expect(url.searchParams.get("cursor")).toBe("c1");
    expect(new URL(issuesListUrl(TARGET, ["11", "12"])).searchParams.getAll("project")).toEqual(["11", "12"]);
  });

  test("next cursor comes from the Link header only when it has results", () => {
    const link = (results: string) =>
      `<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/organizations/acme/issues/?cursor=0:100:0>; rel="next"; results="${results}"; cursor="0:100:0"`;
    expect(nextCursor(link("true"))).toBe("0:100:0");
    expect(nextCursor(link("false"))).toBeNull();
    expect(nextCursor(null)).toBeNull();
  });

  test("status map", () => {
    expect(sentryStatus("unresolved")).toBe("open");
    expect(sentryStatus("resolved")).toBe("resolved");
    expect(sentryStatus("resolvedInNextRelease")).toBe("resolved");
    expect(sentryStatus("ignored")).toBe("ignored");
    expect(sentryStatus("pending_deletion")).toBeNull();
  });

  test("an issue becomes a mirrored group with Sentry's totals and hourly stats", () => {
    const m = issueToMirror(listIssue())!;
    expect(m).toMatchObject({
      kind: "error",
      fp: "sentry-4567",
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      culprit: "app/routes/home.tsx in loader",
      level: "error",
      status: "open",
      count: 42,
      users: 7,
      regressed: false,
      external: { provider: "sentry", id: "4567", url: "https://acme.sentry.io/issues/4567/" },
    });
    expect(m.hourly).toEqual([{ hour: HOUR - 2 * HOUR_MS, count: 30 }, { hour: HOUR, count: 12 }]);
  });

  test("regressed comes from isRegression or the regressed substatus; releases and resolve release from detail", () => {
    expect(issueToMirror(listIssue({ substatus: "regressed" }))!.regressed).toBe(true);
    expect(issueToMirror(listIssue({ isRegression: true }))!.regressed).toBe(true);
    const detail = issueToMirror(listIssue({ status: "resolved", statusDetails: { inRelease: "web@1.5.0" }, firstRelease: { version: "web@1.0.0" }, lastRelease: { version: "web@1.4.2" } }))!;
    expect(detail).toMatchObject({ status: "resolved", resolved_in: "web@1.5.0", first_release: "web@1.0.0", release: "web@1.4.2" });
    expect(issueToMirror(listIssue({ status: "pending_deletion" }))).toBeNull();
    expect(issueToMirror({ title: "no id" })).toBeNull();
  });

  test("org from webhook urls", () => {
    expect(sentryOrgFromUrl("https://sentry.io/api/0/organizations/acme/issues/4567/")).toBe("acme");
    expect(sentryOrgFromUrl("https://sentry.io/api/0/projects/acme/web/events/e1/")).toBe("acme");
    expect(sentryOrgFromUrl("https://acme.sentry.io/issues/4567/")).toBe("acme");
    expect(sentryOrgFromUrl("https://us.sentry.io/issues/4567/")).toBeNull();
    expect(sentryOrgFromUrl(undefined, "not a url")).toBeNull();
  });

  test("a source reads the projects and environments it names", () => {
    const t = { ...TARGET, projects: ["web"], environments: ["production"] };
    expect(targetReads(t, { project_slug: "web" })).toBe(true);
    expect(targetReads(t, { project_slug: "api" })).toBe(false);
    expect(targetReads(t, { project_slug: "web", environment: "staging" })).toBe(false);
    expect(targetReads(TARGET, { project_id: "99", environment: "anything" })).toBe(true);
  });
});

describe("webhook payloads", () => {
  const issueHook = (action: string, issue: Record<string, unknown> = {}) => ({
    action,
    installation: { uuid: "inst-1" },
    data: { issue: { ...listIssue(), url: "https://sentry.io/api/0/organizations/acme/issues/4567/", web_url: "https://sentry.io/organizations/acme/issues/4567/", ...issue } },
    actor: { type: "application", id: "sentry", name: "Sentry" },
  });

  test("issue created, resolved and unresolved carry the issue", () => {
    for (const action of ["created", "resolved", "unresolved"]) {
      const w = parseSentryWebhook("issue", issueHook(action));
      expect(w).toMatchObject({ kind: "issue", org: "acme", project_slug: "web", project_id: "11" });
      expect(JSON.parse((w as any).issue_json).id).toBe("4567");
    }
  });

  test("assignment, other resources and payloads naming no org are skipped", () => {
    expect(parseSentryWebhook("issue", issueHook("assigned")).kind).toBe("skip");
    expect(parseSentryWebhook("installation", { action: "created" }).kind).toBe("skip");
    expect(parseSentryWebhook("issue", issueHook("created", { url: undefined, web_url: undefined, permalink: undefined })).kind).toBe("skip");
  });

  test("an event alert names its issue, project and environment", () => {
    const body = {
      action: "triggered",
      data: {
        event: {
          event_id: "e1",
          issue_id: "4567",
          project: 11,
          environment: "production",
          url: "https://sentry.io/api/0/projects/acme/web/events/e1/",
          web_url: "https://sentry.io/organizations/acme/issues/4567/events/e1/",
        },
        triggered_rule: "New error in web",
      },
    };
    expect(parseSentryWebhook("event_alert", body)).toEqual({ kind: "event", org: "acme", issue_id: "4567", project_id: "11", environment: "production" });
  });
});

describe("issue detail", () => {
  test("frames keep the product's own and the throwing one, with the stopped line and no locals", () => {
    const frames = trimFrames(latestEvent.entries[0].data!.values![0].stacktrace.frames);
    expect(frames).toEqual([
      { file: "app/routes/home.tsx", function: "loader", line: 12, col: 20, in_app: true, code: "return u.id;" },
      { file: "node_modules/lib/index.js", function: "inner", line: 3, col: 1, in_app: false },
    ]);
    expect(trimFrames(Array.from({ length: 80 }, (_, i) => ({ function: `f${i}`, lineNo: i })))).toHaveLength(25);
  });

  test("the trimmed event has the exception, where, release and replay; never locals, emails or request bodies", () => {
    const e = trimEvent(latestEvent)!;
    expect(e).toMatchObject({
      event_id: "e1",
      release: "web@1.4.2",
      environment: "production",
      url: "https://app.acme.dev/home",
      method: "GET",
      user_id: "user_9",
      exceptions: [{ type: "TypeError", handled: false }],
    });
    expect(e.exceptions[0].stack).toBe("  at inner (node_modules/lib/index.js:3:1)\n  at loader (app/routes/home.tsx:12:20)");
    const text = JSON.stringify(e);
    for (const leak of ["secret", "person@example.com", "never", "10.0.0.1"]) expect(text).not.toContain(leak);
    expect(replayIdOf(latestEvent)).toBe("a1b2c3d4e5f6");
    expect(replayIdOf({ tags: [{ key: "replayId", value: "r9" }] })).toBe("r9");
    expect(replayIdOf({})).toBeNull();
  });
});

// ── The poll's read, against a recorded-shape fake ──

type Call = { url: string; init: RequestInit };
function fakeSentry(routes: (url: URL) => { status?: number; body?: unknown; link?: string }) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = routes(new URL(url));
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: r.link ? { link: r.link } : {} });
  };
  return { calls, fetchImpl };
}
const nextLink = (cursor: string) => `<https://sentry.io/x>; rel="next"; results="true"; cursor="${cursor}"`;

describe("readUnresolved", () => {
  test("resolves slugs to ids, follows cursors, and sends the token with redirects refused", async () => {
    const s = fakeSentry((u) => {
      if (u.pathname.endsWith("/projects/")) return { body: [{ id: "11", slug: "web" }, { id: "12", slug: "api" }] };
      if (!u.searchParams.get("cursor")) return { body: [listIssue()], link: nextLink("p2") };
      return { body: [listIssue({ id: "4568" })] };
    });
    const read = await readUnresolved(s.fetchImpl, "tok", { ...TARGET, projects: ["web", "77"] });
    expect(read).toMatchObject({ seen: ["4567", "4568"], truncated: false });
    expect(read.error).toBeUndefined();
    const listCalls = s.calls.filter((c) => c.url.includes("/issues/"));
    expect(new URL(listCalls[0].url).searchParams.getAll("project")).toEqual(["11", "77"]);
    expect(s.calls.every((c) => (c.init.headers as any).Authorization === "Bearer tok" && c.init.redirect === "manual")).toBe(true);
  });

  test("stops at the page cap and says the list was cut short", async () => {
    let n = 0;
    const s = fakeSentry(() => ({ body: [listIssue({ id: String(++n) })], link: nextLink(`p${n}`) }));
    const read = await readUnresolved(s.fetchImpl, "tok", TARGET);
    expect(read.groups).toHaveLength(SENTRY_POLL.max_pages);
    expect(read.truncated).toBe(true);
  });

  test("a refused token is an error with its status and no token in the message", async () => {
    const s = fakeSentry(() => ({ status: 401, body: { detail: "Invalid token" } }));
    const read = await readUnresolved(s.fetchImpl, "sntrys_secret", TARGET);
    expect(read.error?.status).toBe(401);
    expect(read.error?.message).not.toContain("sntrys_secret");
  });

  test("an unknown project slug is refused", async () => {
    const s = fakeSentry(() => ({ body: [{ id: "11", slug: "web" }] }));
    const read = await readUnresolved(s.fetchImpl, "tok", { ...TARGET, projects: ["mobile"] });
    expect(read.error).toMatchObject({ status: 404 });
  });
});

// ── The mirror through the ingest core ──

function world() {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      app_installations: [{ _id: "ai_1", provider: "sentry", team_id: "team_1", access_token_enc: "enc", config: { org: "acme", host: "https://sentry.io" } }],
      counters: [],
      projects: [],
      event_sources: [],
      event_groups: [],
      event_samples: [],
      external_events: [],
      agent_tasks: [],
      conversations: [],
      replays: [],
      webhook_deliveries: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, scheduled, as, internalCtx: { db, scheduler } as any };
}

async function sentrySource(w: ReturnType<typeof world>, config: Record<string, unknown> = { projects: ["web"] }) {
  const { source } = await h(createSource)(w.as("u1"), { workspace: "team", team_id: "team_1", name: "sentry", provider: "sentry", config });
  // The mirror started ten hours ago, so a first seen two hours ago is new.
  await w.db.patch(source._id, { created_at: NOW - 10 * HOUR_MS });
  return (await w.db.get(source._id)) as any;
}

const mirror = (w: ReturnType<typeof world>, sourceId: string, issues: unknown[]) =>
  h(applyMirrorBatch)(w.internalCtx, { source_id: sourceId, groups_json: JSON.stringify(issues.map((i) => issueToMirror(i))) });
const timeline = (w: ReturnType<typeof world>) => w.db._tables.external_events.map((e: any) => e.kind);

describe("mirror", () => {
  test("a new issue becomes one group, announces error_new, fires triggers and promotes", async () => {
    const w = world();
    const source = await sentrySource(w);
    const out = await mirror(w, source._id, [listIssue()]);
    expect(out).toEqual({ mirrored: 1, transitions: 1 });
    const [g] = w.db._tables.event_groups;
    expect(g).toMatchObject({ kind: "error", fingerprint: "error:sentry-4567", status: "open", count: 42, users: 7, external: { provider: "sentry", id: "4567" } });
    expect(timeline(w)).toEqual(["error_new"]);
    expect(w.scheduled.map((s) => s.name)).toEqual(expect.arrayContaining(["agentTasks:matchTaskTriggers", "ingest:promote"]));
    const src = await w.db.get(source._id);
    expect(src).toMatchObject({ groups_open: 1, events_today: 42 });
  });

  test("a second poll with nothing changed writes nothing", async () => {
    const w = world();
    const source = await sentrySource(w);
    await mirror(w, source._id, [listIssue()]);
    const writes = w.db._patched.length + w.db._inserted.length;
    expect(await mirror(w, source._id, [listIssue()])).toEqual({ mirrored: 1, transitions: 0 });
    expect(w.db._patched.length + w.db._inserted.length).toBe(writes);
  });

  test("resolve then new activity: resolved, then error_regressed", async () => {
    const w = world();
    const source = await sentrySource(w);
    await mirror(w, source._id, [listIssue()]);
    await mirror(w, source._id, [listIssue({ status: "resolved" })]);
    expect(w.db._tables.event_groups[0].status).toBe("resolved");
    expect((await w.db.get(source._id)).groups_open).toBe(0);
    await mirror(w, source._id, [listIssue({ substatus: "regressed", count: "50", lastSeen: iso(Date.now() + 1000) })]);
    expect(timeline(w)).toEqual(["error_new", "resolved", "error_regressed"]);
    expect(w.db._tables.event_groups[0]).toMatchObject({ status: "open", count: 50 });
  });

  test("a paused source mirrors nothing", async () => {
    const w = world();
    const source = await sentrySource(w);
    await w.db.patch(source._id, { status: "paused" });
    expect(await mirrorGroups(w.internalCtx, await w.db.get(source._id), [issueToMirror(listIssue())!], NOW)).toEqual({ mirrored: 0, transitions: 0 });
  });

  test("the poll's inputs name the source's connection and its open mirrored issues", async () => {
    const w = world();
    const source = await sentrySource(w);
    await mirror(w, source._id, [listIssue()]);
    const inputs = await h(pollInputs)(w.internalCtx, { source_id: source._id });
    expect(inputs).toMatchObject({ status: "active", connection_id: "ai_1", connection_config: { org: "acme" }, open: ["4567"] });
    expect(JSON.stringify(inputs)).not.toContain("access_token_enc");
  });
});

// ── The webhook ──

const SECRET = "whsec_test";
const sign = async (body: string, secret = SECRET) => hex(await hmacSha256(new TextEncoder().encode(secret).buffer as ArrayBuffer, body));

async function deliver(body: string, headers: Record<string, string>, secret: string | null = SECRET) {
  const prev = process.env.SENTRY_WEBHOOK_SECRET;
  if (secret === null) delete process.env.SENTRY_WEBHOOK_SECRET;
  else process.env.SENTRY_WEBHOOK_SECRET = secret;
  const runs: any[] = [];
  const ctx = { runMutation: async (_fn: any, args: any) => (runs.push(args), { ok: true }) } as any;
  try {
    const res: Response = await h(sentryWebhook)(ctx, new Request("https://site.convex.site/api/webhooks/sentry", { method: "POST", body, headers }));
    return { status: res.status, runs };
  } finally {
    if (prev === undefined) delete process.env.SENTRY_WEBHOOK_SECRET;
    else process.env.SENTRY_WEBHOOK_SECRET = prev;
  }
}

describe("webhook route", () => {
  const body = JSON.stringify({ action: "created", data: { issue: { ...listIssue(), url: "https://sentry.io/api/0/organizations/acme/issues/4567/" } } });

  test("verifyHmacHex: hex HMAC-SHA256 of the raw body, fails closed", async () => {
    const sig = await sign("abc");
    expect(await verifyHmacHex("abc", sig, SECRET)).toBe(true);
    expect(await verifyHmacHex("abc", sig.toUpperCase(), SECRET)).toBe(true);
    expect(await verifyHmacHex("abd", sig, SECRET)).toBe(false);
    expect(await verifyHmacHex("abc", sig, undefined)).toBe(false);
    expect(await verifyHmacHex("abc", null, SECRET)).toBe(false);
  });

  test("no secret configured is 500, a bad or missing signature is 401, and neither schedules anything", async () => {
    expect(await deliver(body, { "sentry-hook-signature": await sign(body), "request-id": "r1", "sentry-hook-resource": "issue" }, null)).toEqual({ status: 500, runs: [] });
    expect(await deliver(body, { "sentry-hook-signature": await sign(body, "other"), "request-id": "r1", "sentry-hook-resource": "issue" })).toEqual({ status: 401, runs: [] });
    expect(await deliver(body, { "request-id": "r1", "sentry-hook-resource": "issue" })).toEqual({ status: 401, runs: [] });
  });

  test("a signed delivery hands its parsed work over; no Request-ID is 400", async () => {
    const ok = await deliver(body, { "sentry-hook-signature": await sign(body), "request-id": "r1", "sentry-hook-resource": "issue" });
    expect(ok.status).toBe(200);
    expect(ok.runs[0].request_id).toBe("r1");
    expect(JSON.parse(ok.runs[0].work_json)).toMatchObject({ kind: "issue", org: "acme" });
    expect((await deliver(body, { "sentry-hook-signature": await sign(body), "sentry-hook-resource": "issue" })).status).toBe(400);
  });

  test("takeWebhook dedupes by Request-ID", async () => {
    const w = world();
    const work_json = JSON.stringify(parseSentryWebhook("issue", JSON.parse(body)));
    expect(await h(takeWebhook)(w.internalCtx, { request_id: "r1", work_json })).toEqual({ ok: true, duplicate: false });
    expect(await h(takeWebhook)(w.internalCtx, { request_id: "r1", work_json })).toEqual({ ok: true, duplicate: true });
    expect(w.scheduled.map((s) => s.name)).toEqual(["sources/sentry:processWebhook"]);
  });

  test("an issue hook mirrors into every source reading its org and project, and no other", async () => {
    const w = world();
    const web = await sentrySource(w, { projects: ["web"] });
    const { source: api } = await h(createSource)(w.as("u1"), { workspace: "team", team_id: "team_1", name: "sentry-api", provider: "sentry", config: { projects: ["api"] } });
    await h(processWebhook)(w.internalCtx, { work_json: JSON.stringify(parseSentryWebhook("issue", JSON.parse(body))) });
    expect(w.db._tables.event_groups.map((g: any) => g.source_id)).toEqual([web._id]);
    expect(api._id).toBeDefined();

    const other = JSON.parse(body);
    other.data.issue.url = "https://sentry.io/api/0/organizations/someone-else/issues/4567/";
    await h(processWebhook)(w.internalCtx, { work_json: JSON.stringify(parseSentryWebhook("issue", other)) });
    expect(w.db._tables.event_groups).toHaveLength(1);
  });

  test("an event alert schedules a re-read of its issue per matching source", async () => {
    const w = world();
    const web = await sentrySource(w, { projects: ["11"], environments: ["production"] });
    const work = { kind: "event", org: "acme", issue_id: "4567", project_id: "11", environment: "production" };
    await h(processWebhook)(w.internalCtx, { work_json: JSON.stringify(work) });
    await h(processWebhook)(w.internalCtx, { work_json: JSON.stringify({ ...work, environment: "staging" }) });
    const refreshes = w.scheduled.filter((s) => s.name === "sources/sentry:refreshIssue");
    expect(refreshes.map((r) => r.args)).toEqual([{ source_id: web._id, issue_id: "4567", environment: "production" }]);
  });
});

// ── On-demand reads and writes ──

describe("public surface", () => {
  test("only issueDetail and setIssueStatus are public; everything holding a connection is internal", () => {
    const fns = Object.entries(sentry).filter(([, f]: [string, any]) => f && (f.isQuery || f.isMutation || f.isAction));
    const pub = fns.filter(([, f]: [string, any]) => f.isPublic).map(([n]) => n).sort();
    expect(pub).toEqual(["issueDetail", "setIssueStatus"]);
  });

  async function withFetch<T>(routes: (url: URL, init: RequestInit) => { status?: number; body?: unknown }, run: (calls: Call[]) => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    const calls: Call[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = routes(new URL(url), init);
      return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
    }) as any;
    try {
      return await run(calls);
    } finally {
      globalThis.fetch = real;
    }
  }

  const TOKEN = "sntrys_SECRET_TOKEN";
  function actionCtx() {
    const mutations: any[] = [];
    const ctx = {
      runQuery: async () => ({ ok: true, group_id: "g1", short_id: "eg-1", source_id: "s1", issue_id: "4567", connection_id: "ai_1", target: TARGET }),
      runAction: async () => ({ ok: true, provider: "sentry", token: TOKEN, config: { org: "acme" } }),
      runMutation: async (_fn: any, args: any) => (mutations.push(args), { mirrored: 1, transitions: 0 }),
    } as any;
    return { ctx, mutations };
  }

  test("issueDetail returns the issue, the trimmed latest event and the replay, links the replay, and never the token", async () => {
    const { ctx, mutations } = actionCtx();
    const out: any = await withFetch(
      (u) => (u.pathname.endsWith("/events/latest/") ? { body: latestEvent } : { body: listIssue({ lastRelease: { version: "web@1.4.2" } }) }),
      () => h(issueDetail)(ctx, { group: "eg-1" }),
    );
    expect(out).toMatchObject({ ok: true, group: "eg-1", issue: { id: "4567", short_id: "WEB-1A", count: 42, last_release: "web@1.4.2" }, replay_id: "a1b2c3d4e5f6" });
    expect(out.event.exceptions[0].frames[0]).toMatchObject({ function: "loader", code: "return u.id;" });
    expect(mutations).toEqual([expect.objectContaining({ group_id: "g1", replay_id: "a1b2c3d4e5f6" })]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  test("issueDetail passes a refused group through untouched", async () => {
    const ctx = { runQuery: async () => ({ ok: false, error: "eg-1 is not a Sentry issue" }) } as any;
    expect(await h(issueDetail)(ctx, { group: "eg-1" })).toEqual({ ok: false, error: "eg-1 is not a Sentry issue" });
  });

  test("setIssueStatus PUTs the status, then mirrors the issue Sentry answers", async () => {
    const { ctx, mutations } = actionCtx();
    const out = await withFetch(
      (_u, init) => ({ body: init.method === "PUT" ? { status: "resolved" } : listIssue({ status: "resolved" }) }),
      async (calls) => {
        const r = await h(setIssueStatus)(ctx, { group: "eg-1", status: "resolved" });
        expect(calls[0]).toMatchObject({ url: "https://sentry.io/api/0/organizations/acme/issues/4567/", init: { method: "PUT", body: JSON.stringify({ status: "resolved" }) } });
        return r;
      },
    );
    expect(out).toEqual({ ok: true, status: "resolved" });
    expect(JSON.parse(mutations[0].groups_json)[0]).toMatchObject({ status: "resolved", external: { id: "4567" } });
  });
});
