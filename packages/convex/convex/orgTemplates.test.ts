import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCatalog, performFileLesson, performInstanceStatus, performListLessons, performMarkSetup, performPublish, performRecordEvidence, performRecordScores, performSetLessonStatus, performUpsertInstance } from "./orgTemplates";
import { applyOrgChange } from "./orgInit";

// Roles hired from a template (org-hire.md W8): the server side of publish,
// catalog, the instance row, its record and lessons, driven through the same
// perform functions the mutations wrap.

const ME = ("u".repeat(31) + "m") as any; // admin of Acme and of the Codecast team
const MATE = ("u".repeat(31) + "t") as any; // Acme member
const OUT = ("u".repeat(31) + "o") as any; // member of another team only
const ACME = "teams_acme" as any, OTHER = "teams_other" as any, CODECAST = "teams_codecast" as any;
const WS = `team:${ACME}`;
const P = "projects_p";

function fixtures() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me" }, { _id: MATE, name: "Mate" }, { _id: OUT, name: "Out" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: ACME, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: ACME, role: "member", joined_at: 1 },
      { _id: "m3", user_id: OUT, team_id: OTHER, role: "admin", joined_at: 1 },
      { _id: "m4", user_id: ME, team_id: CODECAST, role: "admin", joined_at: 1 },
    ],
    teams: [{ _id: ACME, name: "Acme" }, { _id: OTHER, name: "Other" }, { _id: CODECAST, name: "Codecast" }],
    projects: [{ _id: P, user_id: ME, team_id: ACME, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", created_at: 1, updated_at: 1 }],
    org_roles: [{ _id: "role-1", short_id: "or-1", handle: "acme-growth-cmo", name: "CMO", status: "active", trust: "understand", scope_type: "team", team_id: ACME, host_user_id: ME, reports_to: { kind: "user", user_id: ME }, scope: { project_ids: [P], plan_ids: [] }, created_at: 1, updated_at: 1 }],
    org_templates: [], org_template_instances: [], org_template_lessons: [],
    counters: [], org_changes: [], org_role_history: [], anchors: [], conversations: [], session_owners: [], managed_sessions: [], tasks: [], plans: [], docs: [],
  });
}
const manifest = (version = "2.0.0"): any => ({
  schemaVersion: 2, id: "growth", version, name: "CMO", description: "One project CMO",
  role: { name: "CMO", handle: "{{instance}}-cmo", charter: "org/charter.md", caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 }, avatar: "fox" },
  inputs: [{ key: "product.domain", label: "Domain", kind: "string", required: true }, { key: "accounts.ads", label: "Ads credentials", kind: "secret" }],
  authority: [{ id: "ads-spend", kind: "spend", label: "Paid search" }],
  setup: [{ id: "search-console", title: "Verify the domain", who: "human", unlocks: ["seo"] }, { id: "measurement", title: "See one event", who: "role" }],
  evidence: [{ id: "technical", title: "Crawler HTML", max_age: "7d", required_for: ["seo"] }],
  scoreboard: [{ key: "primary_events_7d", label: "Primary events" }],
  routines: [{ id: "seo", title: "SEO weekly", every: "7d", prompt: "org/seo.md", mode: "apply", requires: { evidence: ["technical"] } }, { id: "ads", title: "Ads", every: "1d", prompt: "org/ads.md", mode: "apply", requires: { authority: ["ads-spend"] } }],
});
const D1 = "a".repeat(64), D2 = "b".repeat(64), D3 = "c".repeat(64);
const ctx = (db: any) => ({ db } as any);

describe("publish and catalog", () => {
  beforeEach(() => { process.env.CODECAST_TEMPLATES_TEAM_ID = CODECAST; });
  afterEach(() => { delete process.env.CODECAST_TEMPLATES_TEAM_ID; });
  test("a workspace publishes, advances and cannot rewrite a version; Codecast publishing is its admins' act", async () => {
    const db = fixtures();
    const first = await performPublish(ctx(db), ME, { team_id: ACME, manifest: manifest(), digest: D1, status: "canary", changelog: "first" });
    expect(first).toMatchObject({ action: "created", workspace: WS, template_id: "growth", latest: { version: "2.0.0", digest: D1 }, avatar: "fox" });
    expect(first.releases[0]).toMatchObject({ version: "2.0.0", digest: D1, status: "canary", changelog: "first" });
    expect(first.releases[0].manifest.version).toBe("2.0.0");
    await expect(performPublish(ctx(db), ME, { team_id: ACME, manifest: manifest(), digest: D2 })).rejects.toThrow(/already published with different content/);
    const promoted = await performPublish(ctx(db), ME, { team_id: ACME, manifest: manifest(), digest: D1, status: "stable" });
    expect(promoted.action).toBe("updated"); expect(promoted.releases).toHaveLength(1); expect(promoted.releases[0].status).toBe("stable");
    const next = await performPublish(ctx(db), MATE, { team_id: ACME, manifest: manifest("2.1.0"), digest: D2 });
    expect(next).toMatchObject({ action: "released", latest: { version: "2.1.0", digest: D2 } }); expect(next.releases).toHaveLength(2);
    await expect(performPublish(ctx(db), ME, { team_id: ACME, manifest: { ...manifest(), id: "Bad Id" }, digest: D3 })).rejects.toThrow(/Invalid template id/);
    await expect(performPublish(ctx(db), OUT, { team_id: ACME, manifest: manifest(), digest: D1 })).rejects.toThrow();
    await expect(performPublish(ctx(db), MATE, { as_codecast: true, manifest: manifest(), digest: D1 })).rejects.toThrow();
    const shared = await performPublish(ctx(db), ME, { as_codecast: true, manifest: manifest(), digest: D1, status: "stable" });
    expect(shared.workspace).toBe("codecast");
    delete process.env.CODECAST_TEMPLATES_TEAM_ID;
    await expect(performPublish(ctx(db), ME, { as_codecast: true, manifest: manifest("2.2.0"), digest: D3 })).rejects.toThrow(/not enabled/);
  });
  test("the catalog is one equality against the viewer's key plus Codecast's", async () => {
    const db = fixtures();
    await performPublish(ctx(db), ME, { team_id: ACME, manifest: { ...manifest(), id: "acme-only" }, digest: D1 });
    await performPublish(ctx(db), ME, { as_codecast: true, manifest: manifest(), digest: D2 });
    await performPublish(ctx(db), OUT, { team_id: OTHER, manifest: { ...manifest(), id: "other-only" }, digest: D3 });
    expect((await performCatalog(ctx(db), MATE, { team_id: ACME })).map((t) => t.template_id).sort()).toEqual(["acme-only", "growth"]);
    expect((await performCatalog(ctx(db), OUT, { team_id: OTHER })).map((t) => t.template_id).sort()).toEqual(["growth", "other-only"]);
    expect((await performCatalog(ctx(db), MATE, {})).map((t) => t.template_id)).toEqual(["growth"]);
    await expect(performCatalog(ctx(db), OUT, { team_id: ACME })).rejects.toThrow();
    const entry = (await performCatalog(ctx(db), MATE, { team_id: ACME })).find((t) => t.template_id === "growth")!;
    expect(entry.asks).toEqual({ inputs: 2, secrets: 1, authority: 1, setup: 2, routines: 2 });
  });
});

describe("the instance row, its record and lessons", () => {
  beforeEach(() => { process.env.CODECAST_TEMPLATES_TEAM_ID = CODECAST; });
  afterEach(() => { delete process.env.CODECAST_TEMPLATES_TEAM_ID; });
  const hire = { instance_key: "key-1", instance: "acme-growth", template_id: "growth", version: "2.0.0", digest: D1, project_id: P as any };
  test("upsert by key under the project's workspace; secrets and unpublished releases refused", async () => {
    const db = fixtures();
    await expect(performUpsertInstance(ctx(db), ME, hire)).rejects.toThrow(/not available to this workspace/);
    await performPublish(ctx(db), ME, { as_codecast: true, manifest: manifest(), digest: D1, status: "stable" });
    await expect(performUpsertInstance(ctx(db), ME, { ...hire, digest: D2 })).rejects.toThrow(/not published/);
    await expect(performUpsertInstance(ctx(db), ME, { ...hire, config: { "accounts.ads": "/x" } })).rejects.toThrow(/bound on the host/);
    await expect(performUpsertInstance(ctx(db), OUT, hire)).rejects.toThrow(/Project not found/);
    const row = await performUpsertInstance(ctx(db), MATE, { ...hire, phase: "awaiting_host", config: { "product.domain": "acme.io" } });
    expect(row).toMatchObject({ workspace: WS, phase: "awaiting_host", update_policy: "manual", config: { "product.domain": "acme.io" } });
    const bound = await performUpsertInstance(ctx(db), MATE, { ...hire, role_id: "role-1" as any, host: { machine: "mbp", dir: "/src/acme" }, phase: "ready", bindings: { "accounts.ads": { host: "mbp", path_hash: D3, bound_at: 5 } }, ledgers: { cmo: { taskId: "t1", shortId: "ct-1" } } });
    expect(bound._id).toBe(row._id); expect(bound).toMatchObject({ phase: "ready", role_id: "role-1", host: { machine: "mbp", dir: "/src/acme" }, config: { "product.domain": "acme.io" } });
    expect(await db.query("org_template_instances").collect()).toHaveLength(1);
  });
  test("evidence, scoreboard and setup through the shared rules; status derives readiness and the ask; lessons reach the publisher only", async () => {
    const db = fixtures();
    await performPublish(ctx(db), ME, { as_codecast: true, manifest: manifest(), digest: D1, status: "stable" });
    await performUpsertInstance(ctx(db), ME, { ...hire, role_id: "role-1" as any });
    const key = { instance_key: "key-1" };
    await expect(performRecordEvidence(ctx(db), OUT, { ...key, check: "technical", status: "pass", source: "ct-1" })).rejects.toThrow(/Instance not found/);
    await expect(performRecordEvidence(ctx(db), MATE, { ...key, check: "technical", status: "pass" })).rejects.toThrow(/a person can open/);
    let status = await performInstanceStatus(ctx(db), MATE, key);
    expect(status.ask).toMatchObject({ id: "search-console", who: "human" });
    expect(status.readiness.seo).toEqual({ ready: false, mode: "propose", missing: ["evidence technical has no pass"] });
    expect(status.readiness.ads.missing).toEqual(["authority ads-spend not granted", "runs as propose: trust is understand"]);
    await performRecordEvidence(ctx(db), MATE, { ...key, check: "technical", status: "pass", source: "https://codecast.sh/t/ct-1", detail: ["routes=38"] });
    await performRecordScores(ctx(db), MATE, { ...key, entries: ["primary_events_7d=7"], source: "ct-2" });
    await expect(performMarkSetup(ctx(db), MATE, { ...key, id: "search-console", status: "done", from_agent: true })).rejects.toThrow(/person's step/);
    await performMarkSetup(ctx(db), MATE, { ...key, id: "search-console", status: "done", from_agent: false });
    await performMarkSetup(ctx(db), MATE, { ...key, id: "measurement", status: "done", evidence: "ct-3", from_agent: true });
    status = await performInstanceStatus(ctx(db), MATE, key);
    expect(status.readiness.seo).toEqual({ ready: true, mode: "apply", missing: [] });
    expect(status.scoreboard.primary_events_7d).toMatchObject({ value: "7", source: "ct-2" });
    expect(status.ask).toBeUndefined();
    expect(status.setup.map((r: any) => [r.id, r.status])).toEqual([["search-console", "done"], ["measurement", "done"]]);
    // Lessons: written by the instance, filed under the publisher's key.
    await expect(performFileLesson(ctx(db), MATE, { ...key, body: "too short" })).rejects.toThrow(/at least a sentence/);
    const lesson = await performFileLesson(ctx(db), MATE, { ...key, body: "Pair the parity test with a module resolution guard; a registered route without its page passes parity and disables the prerender.", evidence: [{ label: "SEO ledger", href: "ct-48700" }] });
    expect(lesson.status).toBe("open");
    const mine = await performListLessons(ctx(db), MATE, key);
    expect(mine).toHaveLength(1); expect(Object.keys(mine[0]!).sort()).toEqual(["body", "created_at", "id", "released_in", "status"]);
    await expect(performListLessons(ctx(db), MATE, { template_id: "growth", team_id: ACME })).resolves.toEqual([]);
    await expect(performListLessons(ctx(db), MATE, { template_id: "growth", as_codecast: true })).rejects.toThrow();
    const forPublisher = await performListLessons(ctx(db), ME, { template_id: "growth", as_codecast: true });
    expect(forPublisher).toHaveLength(1); expect(forPublisher[0]).toMatchObject({ workspace: "codecast", from_workspace: WS, release: { version: "2.0.0", digest: D1 } });
    await expect(performSetLessonStatus(ctx(db), MATE, { lesson_id: lesson.id, status: "accepted" })).rejects.toThrow();
    await expect(performSetLessonStatus(ctx(db), ME, { lesson_id: lesson.id, status: "released" })).rejects.toThrow(/Name the version/);
    expect((await performSetLessonStatus(ctx(db), ME, { lesson_id: lesson.id, status: "released", released_in: "2.1.0" })).status).toBe("released");
    expect((await performListLessons(ctx(db), MATE, key))[0]).toMatchObject({ status: "released", released_in: "2.1.0" });
  });
});

describe("the hire and upgrade changes through the org apply core (org-hire.md H3, H9)", () => {
  beforeEach(() => { process.env.CODECAST_TEMPLATES_TEAM_ID = CODECAST; });
  afterEach(() => { delete process.env.CODECAST_TEMPLATES_TEAM_ID; });
  const boundary = { team_id: ACME } as any;
  const human = { provision: false, human_decision: "sd-1" } as any;
  const humanCtx = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: ME }) } }) as any;
  test("a hire writes the placeholder row awaiting its host, makes the role the project's lead, and the host's bind takes the row over by name", async () => {
    const db = fixtures();
    await performPublish(ctx(db), ME, { as_codecast: true, manifest: manifest(), digest: D1, status: "stable" });
    const hire = { kind: "hire", handle: "acme-growth-cmo", template: "growth", version: "2.0.0", digest: D1, instance: "acme-growth", project: "pr-1", config: { "product.domain": "acme.io" }, update_policy: "stable" } as const;
    await expect(applyOrgChange(humanCtx(db), ME, boundary, { ...hire, digest: D2 }, human)).rejects.toThrow(/not published/);
    const applied = await applyOrgChange(humanCtx(db), ME, boundary, hire, human);
    expect(applied.status).toBe("applied");
    expect((applied as any).note).toContain("it leads Growth");
    const rows = await db.query("org_template_instances").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instance: "acme-growth", phase: "awaiting_host", role_id: "role-1", workspace: WS, update_policy: "stable", config: { "product.domain": "acme.io" } });
    expect(rows[0].instance_key).toMatch(/^pending:/);
    expect((await db.get(P as any)).owner_role_id).toBe("role-1");
    // The host step arrives with the receipt's key and takes the same row.
    const bound = await performUpsertInstance(ctx(db), ME, { instance_key: "receipt-uuid", instance: "acme-growth", template_id: "growth", version: "2.0.0", digest: D1, project_id: P as any, role_id: "role-1" as any, host: { machine: "mbp", dir: "/src/acme" }, phase: "ready" });
    expect(bound._id).toBe(rows[0]._id);
    expect(bound).toMatchObject({ instance_key: "receipt-uuid", phase: "ready", config: { "product.domain": "acme.io" } });
    expect(await db.query("org_template_instances").collect()).toHaveLength(1);
    // A second host with another key cannot take a bound row by name.
    await expect(performUpsertInstance(ctx(db), ME, { instance_key: "other-host", instance: "acme-growth", template_id: "growth", version: "2.0.0", digest: D1, project_id: P as any })).rejects.toThrow(/under another host/);
    // Authority through the same core lands on the role.
    const granted = await applyOrgChange(humanCtx(db), ME, boundary, { kind: "authority", handle: "acme-growth-cmo", authority: [{ id: "ads-spend", kind: "spend", label: "Paid search", limit: { usd_per_month: 300 } }] }, human);
    expect((granted as any).note).toBe("@acme-growth-cmo may spend (Paid search, up to $300 a month)");
    expect((await performInstanceStatus(ctx(db), MATE, { instance_key: "receipt-uuid" })).readiness.ads.missing).toEqual(["runs as propose: trust is understand"]);
    // An accepted upgrade waits on the row for the host.
    await performPublish(ctx(db), ME, { as_codecast: true, manifest: manifest("2.1.0"), digest: D2, status: "stable" });
    await expect(applyOrgChange(humanCtx(db), ME, boundary, { kind: "upgrade", instance: "acme-growth", template: "growth", to: "2.1.0", digest: D3 }, human)).rejects.toThrow(/not published/);
    const up = await applyOrgChange(humanCtx(db), ME, boundary, { kind: "upgrade", instance: "acme-growth", template: "growth", to: "2.1.0", digest: D2 }, human);
    expect((up as any).note).toContain("bind acme-growth --to 2.1.0");
    expect((await db.get(rows[0]._id)).pending_upgrade).toMatchObject({ to: "2.1.0", digest: D2, accepted_by: ME });
  });
});
