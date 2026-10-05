import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { learningEnabled, performDigest, performFileLearned, performLearnDue, performLearnStatus, performLearning, performPassPlan, performRollout, performSetLearning } from "./orgTemplateLearning";
import { performListLessons, performUpsertInstance } from "./orgTemplates";

// The learning loop (org-hire.md H12), through the perform functions the
// wrappers and the pass action call: the opt-in gates every read, a lesson
// that carries the workspace is refused, and the publisher reads counts.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ME = "users_me" as any; // admin of the Codecast team: the publisher
const DANA = "users_dana" as any; // admin of Acme
const MATE = "users_mate" as any; // Acme member
const ACME = "teams_acme" as any, CODECAST = "teams_codecast" as any;
const WS = `team:${ACME}`;
const P = "projects_p", ROLE = "org_roles_cmo", STANDING = "conversations_standing", HAND = "conversations_hand", INSTANCE = "org_template_instances_acme";
const D1 = "a".repeat(64), D2 = "b".repeat(64);

const manifest = (version = "2.0.0"): any => ({
  schemaVersion: 2, id: "growth", version, name: "CMO", description: "Positioning and steady marketing for one project",
  role: { name: "CMO", handle: "{{instance}}-cmo", charter: "org/charter.md", caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 } },
  inputs: [{ key: "product.domain", label: "Domain", kind: "string", required: true }],
  setup: [{ id: "search-console", title: "Verify the domain", who: "human" }],
  evidence: [{ id: "technical", title: "Crawler HTML verified", max_age: "7d" }],
  routines: [{ id: "seo", title: "SEO weekly", every: "7d", prompt: "org/seo.md" }],
});
const release = (version: string, digest: string, status: string, published_at = NOW - 10 * DAY) => ({ version, digest, status, manifest: manifest(version), published_at, published_by: ME, storage_id: "storage_1" });
const template = (releases: any[]) => ({ _id: "org_templates_growth", template_id: "growth", workspace: "codecast", name: "CMO", description: "d", latest: { version: releases.at(-1).version, digest: releases.at(-1).digest }, releases, manifest: manifest(releases.at(-1).version), created_by: ME, created_at: 1, updated_at: 1 });
const instance = (over: Record<string, any> = {}) => ({ _id: INSTANCE, instance_key: "key-acme", instance: "acme-growth", workspace: WS, template_id: "growth", version: "2.0.0", digest: D1, project_id: P, role_id: ROLE, phase: "ready", update_policy: "stable", config: { "product.domain": "acme.com" }, host: { machine: "danas-mbp", dir: "/src/acme" }, routines: { seo: { triggerId: "agent_tasks_seo" } }, created_by: DANA, created_at: NOW - 9 * DAY, updated_at: NOW - 9 * DAY, version_at: NOW - 9 * DAY, ...over });
const message = (id: string, conversation: string, role: string, at: number, content: string, over: Record<string, any> = {}) => ({ _id: `messages_${id}`, conversation_id: conversation, role, timestamp: at, content, ...over });

function fixtures(over: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Publisher" }, { _id: DANA, name: "Dana Whitfield", email: "dana@acme.com" }, { _id: MATE, name: "Sam Okafor" }],
    teams: [{ _id: ACME, name: "Acme Robotics" }, { _id: CODECAST, name: "Codecast" }],
    team_memberships: [
      { _id: "team_memberships_1", user_id: ME, team_id: CODECAST, role: "admin", joined_at: 1 },
      { _id: "team_memberships_2", user_id: DANA, team_id: ACME, role: "admin", joined_at: 1 },
      { _id: "team_memberships_3", user_id: MATE, team_id: ACME, role: "member", joined_at: 1 },
    ],
    projects: [{ _id: P, user_id: DANA, team_id: ACME, workspace: WS, short_id: "pr-1", title: "Pallet Web", status: "active", created_at: 1, updated_at: 1 }],
    org_roles: [{ _id: ROLE, short_id: "or-1", handle: "acme-growth-cmo", name: "CMO", status: "active", trust: "understand", scope_type: "team", team_id: ACME, host_user_id: DANA, anchor_id: "anchors_cmo", scope: { project_ids: [P], plan_ids: [] }, created_at: 1, updated_at: 1 }],
    anchors: [{ _id: "anchors_cmo", org_role_id: ROLE, team_id: ACME, status: "active", conversation_id: STANDING }],
    conversations: [
      { _id: STANDING, user_id: DANA, standing_role_id: ROLE, project_path: "/src/acme", updated_at: NOW - DAY },
      { _id: HAND, user_id: DANA, org_role_id: ROLE, updated_at: NOW - DAY },
    ],
    messages: [
      message("old", STANDING, "user", NOW - 30 * DAY, "This was said long before the window and is never read."),
      message("a1", STANDING, "assistant", NOW - 3 * DAY - 10, "I posted the launch draft for Pallet to the blog."),
      message("u1", STANDING, "user", NOW - 3 * DAY, "No. Never publish anything before I have read it."),
      message("tool", STANDING, "user", NOW - 2 * DAY, "tool output", { tool_results: [{ tool_use_id: "t", content: "x" }] }),
      message("machine", STANDING, "user", NOW - 2 * DAY + 1, '<session-message from="jx7abcd">a worker reports back</session-message>'),
      message("u2", HAND, "user", NOW - DAY, "Use the staging property, not production, for the first check."),
    ],
    agent_tasks: [{ _id: "agent_tasks_seo", user_id: DANA, short_id: "tr-7", title: "SEO weekly", prompt: "p", schedule_type: "recurring", interval_ms: 7 * DAY, mode: "propose", status: "scheduled", run_count: 2, retry_count: 0, last_run_at: NOW - DAY, last_run_failed: true, last_run_summary: "Search Console was not verified for acme.com.", created_at: 1 }],
    org_templates: [template([release("2.0.0", D1, "stable")])],
    org_template_instances: [instance()],
    org_template_lessons: [], org_template_learning: [], org_changes: [], counters: [], devices: [], daemon_commands: [],
    ...over,
  }, { indexes: schemaIndexes(schema as any) });
}
const ctx = (db: any) => ({ db } as any);
const optIn = (db: any) => performSetLearning(ctx(db), DANA, { team_id: ACME, enabled: true });

beforeEach(() => { process.env.CODECAST_TEMPLATES_TEAM_ID = CODECAST; });
afterEach(() => { delete process.env.CODECAST_TEMPLATES_TEAM_ID; });

describe("the opt-in", () => {
  test("off by default; a team's admin turns it on and off; a member reads it and cannot change it", async () => {
    const db = fixtures();
    expect(await learningEnabled(ctx(db), WS)).toBe(false);
    expect(await performLearning(ctx(db), MATE, { team_id: ACME })).toMatchObject({ workspace: WS, enabled: false, changed_by: null, can_change: false });
    await expect(performSetLearning(ctx(db), MATE, { team_id: ACME, enabled: true })).rejects.toThrow(/team admin required/);
    expect(await optIn(db)).toMatchObject({ enabled: true, changed_by: "Dana Whitfield", can_change: true });
    expect(await learningEnabled(ctx(db), WS)).toBe(true);
    expect(await performSetLearning(ctx(db), DANA, { team_id: ACME, enabled: false })).toMatchObject({ enabled: false });
    expect(await db.query("org_template_learning").collect()).toHaveLength(1);
    await expect(performLearning(ctx(db), ME, { team_id: ACME })).rejects.toThrow(/team membership required/);
  });
  test("a personal workspace is its owner's to opt in", async () => {
    const db = fixtures();
    expect(await performSetLearning(ctx(db), MATE, { enabled: true })).toMatchObject({ workspace: `user:${MATE}`, enabled: true, can_change: true });
    expect(await learningEnabled(ctx(db), WS)).toBe(false);
  });
});

describe("the pass reads only what opted in", () => {
  test("the plan is the publisher's, and lists no instance of a workspace that did not opt in", async () => {
    const db = fixtures();
    await expect(performPassPlan(ctx(db), DANA, { template_id: "growth", now: NOW })).rejects.toThrow(/Forbidden/);
    await expect(performPassPlan(ctx(db), ME, { template_id: "nope", now: NOW })).rejects.toThrow(/No Codecast template/);
    expect(await performPassPlan(ctx(db), ME, { template_id: "growth", now: NOW })).toMatchObject({ instances: [], remaining: 0 });
    await optIn(db);
    expect(await performPassPlan(ctx(db), ME, { template_id: "growth", now: NOW })).toMatchObject({ user_id: ME, instances: [INSTANCE], remaining: 0 });
  });
  test("the digest is refused without the opt-in, even for an instance a plan already named", async () => {
    const db = fixtures();
    expect(await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW })).toBeNull();
    await optIn(db);
    expect(await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW })).not.toBeNull();
    await performSetLearning(ctx(db), DANA, { team_id: ACME, enabled: false });
    expect(await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW })).toBeNull();
    expect(await performFileLearned(ctx(db), { instance_id: INSTANCE, user_id: ME, reply: "[]", signal_keys: [], now: NOW })).toMatchObject({ read: false, filed: [] });
  });
  // The role's own playbook (org-staffing.md S38): the rules it learned are
  // one more signal, read once, and only behind the same opt-in.
  test("the digest carries the rules the role taught itself, each once, and a lesson drawn from one still passes the leak check", async () => {
    const BRIEF = "docs_brief";
    const brief = "CMO: steady\n\n## Rules learned\n- Check the live page before calling a page shipped. Learned from: a post sat merged and unpublished for four days. (2026-09-20)\n- Ask Dana before changing the Pallet pricing copy. Learned from: the copy was changed twice in a week. (2026-09-25)";
    const db = fixtures({ docs: [{ _id: BRIEF, doc_type: "brief", content: brief }] });
    await db.patch(ROLE, { brief_doc_id: BRIEF });
    expect(await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW })).toBeNull();
    await optIn(db);
    const digest = (await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW }))!;
    const ruleKeys = digest.signal_keys.filter((k) => k.startsWith("rule:"));
    expect(ruleKeys).toHaveLength(2);
    expect(digest.request!.prompt).toContain("# Rules the role taught itself");
    expect(digest.request!.prompt).toContain("Check the live page before calling a page shipped. It learned this from: a post sat merged and unpublished for four days");
    // One generalizes and is filed; one carries the workspace and is refused, its text going nowhere.
    const reply = JSON.stringify([
      { kind: "rule", about: "charter", lesson: "The charter should tell the role to confirm a page is live before it reports the page as shipped, since a merged change is not a published one." },
      { kind: "rule", about: "charter", lesson: "The role should ask Dana before it changes pricing copy for Pallet." },
    ]);
    const filed = await performFileLearned(ctx(db), { instance_id: INSTANCE, user_id: ME, reply, signal_keys: digest.signal_keys, now: NOW });
    expect(filed.filed).toHaveLength(1);
    expect(filed.filed[0]).toMatchObject({ kind: "rule", about: "charter" });
    expect(filed.refused).toMatchObject({ name: 1 });
    // The next pass does not read the same rules again; a new one is read.
    const next = (await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW + DAY }))!;
    expect(next.signal_keys.filter((k) => k.startsWith("rule:"))).toEqual([]);
    await db.patch(BRIEF, { content: `${brief}\n- Run a guide's steps on a fresh account before marking it reviewed. Learned from: a guide assumed an admin seat. (2026-10-01)` });
    const later = (await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW + 2 * DAY }))!;
    expect(later.signal_keys.filter((k) => k.startsWith("rule:"))).toHaveLength(1);
    expect(later.request!.prompt).toContain("Run a guide's steps on a fresh account");
    expect(later.request!.prompt).not.toContain("Check the live page before calling a page shipped");
  });
  test("a workspace's own template of the same id is not Codecast's to learn from", async () => {
    const own = { ...template([release("2.0.0", D1, "stable")]), _id: "org_templates_own", workspace: WS };
    const db = fixtures({ org_templates: [template([release("2.0.0", D1, "stable")]), own] });
    await optIn(db);
    expect(await performPassPlan(ctx(db), ME, { template_id: "growth", now: NOW })).toMatchObject({ instances: [] });
    expect(await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW })).toBeNull();
  });
  test("the digest carries what people typed with the role's line before it, and the record's stalls; machine messages and old ones are left out", async () => {
    const db = fixtures();
    await optIn(db);
    const digest = (await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW }))!;
    expect(digest.signal_keys).toEqual(["setup:search-console:open", `routine:seo:failed:${NOW - DAY}`]);
    const prompt = digest.request!.prompt;
    expect(prompt).toContain("The role had said: I posted the launch draft for Pallet to the blog.");
    expect(prompt).toContain("A person then typed: No. Never publish anything before I have read it.");
    expect(prompt).toContain("A person then typed: Use the staging property, not production, for the first check.");
    expect(prompt).toContain("Routine seo (SEO weekly) failed its last run. The role's summary of it: Search Console was not verified for acme.com.");
    for (const absent of ["long before the window", "tool output", "a worker reports back"]) expect(prompt).not.toContain(absent);
  });
  test("nothing typed and nothing stalled asks no model", async () => {
    const db = fixtures({ messages: [], agent_tasks: [], org_template_instances: [instance({ created_at: NOW - DAY, routines: {} })] });
    await optIn(db);
    expect(await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW })).toEqual({ request: null, signal_keys: [] });
  });
});

describe("filing what was learned", () => {
  const clean = { kind: "redirect", about: "charter", lesson: "The role published a draft before a person had read it. The charter should say that nothing is published until a person approves it." };
  const reply = (lessons: any[]) => JSON.stringify(lessons);
  test("a general lesson is filed on the template under the publisher's key; a lesson that carries the workspace is dropped and counted", async () => {
    const db = fixtures();
    await optIn(db);
    const result = await performFileLearned(ctx(db), { instance_id: INSTANCE, user_id: ME, signal_keys: ["setup:search-console:open"], now: NOW, reply: reply([
      clean,
      { kind: "setup", about: "search-console", lesson: "Dana could not find who owns the Search Console property, so the step should name where to look." },
      { kind: "routine", about: "seo", lesson: "The seo routine failed because acme.com was not verified; it should check the step first." },
      { kind: "redirect", about: "charter", lesson: "The launch of Pallet Web was announced early; the charter should require a date from a person." },
      { kind: "redirect", about: "charter", lesson: 'A person wrote "never publish anything before I have read it" and the charter should say so.' },
    ]) });
    expect(result).toMatchObject({ read: true, failed: false, refused: { name: 3, url: 1, quote: 1 } });
    expect(result.filed).toEqual([{ id: expect.any(String), kind: "redirect", about: "charter", body: clean.lesson }]);
    const rows = await db.query("org_template_lessons").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template_id: "growth", workspace: "codecast", from_workspace: WS, source: "learning", kind: "redirect", about: "charter", status: "open", evidence: [], release: { version: "2.0.0", digest: D1 }, created_by: ME });
    expect((await db.get(INSTANCE)).learning).toEqual({ at: NOW, seen: ["setup:search-console:open"] });
  });
  test("the publisher reads a learned lesson without where it came from; the workspace reads what left it", async () => {
    const db = fixtures();
    await optIn(db);
    await performFileLearned(ctx(db), { instance_id: INSTANCE, user_id: ME, signal_keys: [], now: NOW, reply: reply([clean]) });
    const [forPublisher] = await performListLessons(ctx(db), ME, { template_id: "growth", as_codecast: true });
    expect(forPublisher).toMatchObject({ body: clean.lesson, source: "learning", kind: "redirect" });
    for (const hidden of ["from_workspace", "instance_key", "created_by"]) expect(forPublisher).not.toHaveProperty(hidden);
    expect(await performListLessons(ctx(db), MATE, { instance_key: "key-acme" })).toEqual([expect.objectContaining({ body: clean.lesson, source: "learning", status: "open" })]);
  });
  test("a taught signal is not taught again; a failed model call leaves the cursor for the next pass", async () => {
    const db = fixtures();
    await optIn(db);
    expect(await performFileLearned(ctx(db), { instance_id: INSTANCE, user_id: ME, reply: null, signal_keys: ["setup:search-console:open"], now: NOW })).toMatchObject({ read: true, failed: true });
    expect((await db.get(INSTANCE)).learning).toBeUndefined();
    const first = (await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW }))!;
    await performFileLearned(ctx(db), { instance_id: INSTANCE, user_id: ME, reply: "[]", signal_keys: first.signal_keys, now: NOW });
    expect(await performDigest(ctx(db), { instance_id: INSTANCE, now: NOW + DAY })).toEqual({ request: null, signal_keys: [] });
    expect(await performPassPlan(ctx(db), ME, { template_id: "growth", now: NOW + 60_000 })).toMatchObject({ instances: [] });
  });
  test("a reply that is not a list files nothing and still moves the cursor", async () => {
    const db = fixtures();
    await optIn(db);
    expect(await performFileLearned(ctx(db), { instance_id: INSTANCE, user_id: ME, reply: "I found nothing to generalize.", signal_keys: [], now: NOW })).toMatchObject({ read: true, filed: [], refused: {} });
    expect((await db.get(INSTANCE)).learning.at).toBe(NOW);
  });
});

describe("what the publisher reads", () => {
  const lesson = (n: number, over: Record<string, any> = {}) => ({ _id: `org_template_lessons_${n}`, template_id: "growth", workspace: "codecast", from_workspace: WS, instance_key: "key-acme", release: { version: "2.0.0", digest: D1 }, body: "A lesson about the template in general terms.", evidence: [], status: "open", source: "learning", created_by: ME, created_at: NOW - DAY, updated_at: NOW - DAY, ...over });
  test("a draft is due at three open lessons, with the next version; nothing is due before", async () => {
    const db = fixtures({ org_template_lessons: [lesson(1), lesson(2)] });
    await expect(performLearnStatus(ctx(db), DANA, { template_id: "growth", now: NOW })).rejects.toThrow(/Forbidden/);
    expect(await performLearnStatus(ctx(db), ME, { template_id: "growth", now: NOW })).toMatchObject({ stable: "2.0.0", canary: null, lessons: { open: 2 }, draft: { due: false, next_version: "2.0.1" }, instances: { total: 1, opted_in: 0, canary: 0 }, due: { pass: false, draft: false, rollout: false, promote: false } });
    expect(await performLearnDue(ctx(db), ME, { now: NOW })).toEqual({ due: false, templates: [] });
    await db.insert("org_template_lessons", lesson(3));
    await optIn(db);
    expect((await performLearnStatus(ctx(db), ME, { template_id: "growth", now: NOW })).due).toEqual({ pass: true, draft: true, rollout: false, promote: false });
    expect(await performLearnDue(ctx(db), ME, { now: NOW })).toEqual({ due: true, templates: [{ template_id: "growth", due: ["pass", "draft"] }] });
  });
  test("a canary waits for its instances, then for a clean run and the soak; a lesson learned on it makes the next draft due instead", async () => {
    const canary = release("2.0.1", D2, "canary", NOW - 4 * DAY);
    const db = fixtures({ org_templates: [template([release("2.0.0", D1, "stable"), canary])], org_template_instances: [instance({ update_policy: "canary" })], org_template_lessons: [lesson(1), lesson(2), lesson(3)] });
    let status = await performLearnStatus(ctx(db), ME, { template_id: "growth", now: NOW });
    expect(status.canary).toMatchObject({ version: "2.0.1", clean: false, why: "no canary instance has taken the release yet", instances: [{ on_release: false, pending: false }] });
    expect(status.due).toMatchObject({ draft: false, rollout: true, promote: false });
    // The host's bind lands the release; the last run predates it, so nothing has run on it yet.
    await db.patch(INSTANCE, { version: "2.0.1", digest: D2, version_at: NOW - 12 * 3_600_000 });
    status = await performLearnStatus(ctx(db), ME, { template_id: "growth", now: NOW });
    expect(status.canary).toMatchObject({ clean: false, why: "a canary instance has not completed a run on this release yet" });
    await db.patch("agent_tasks_seo", { last_run_at: NOW - 3_600_000, last_run_failed: false });
    status = await performLearnStatus(ctx(db), ME, { template_id: "growth", now: NOW });
    expect(status.canary).toMatchObject({ clean: true, instances: [{ on_release: true, ran: true, failed: false }] });
    expect(status.due).toMatchObject({ rollout: false, promote: true, draft: false });
    await db.insert("org_template_lessons", lesson(4, { release: { version: "2.0.1", digest: D2 } }));
    status = await performLearnStatus(ctx(db), ME, { template_id: "growth", now: NOW });
    expect(status.canary).toMatchObject({ clean: false, lessons_since: 1 });
    expect(status.due).toMatchObject({ promote: false, draft: true });
  });
});

describe("canary rollout", () => {
  const canary = release("2.0.1", D2, "canary", NOW - DAY);
  const withCanary = (over: Record<string, any> = {}) => fixtures({
    org_templates: [template([release("2.0.0", D1, "stable"), canary])],
    org_template_instances: [instance({ update_policy: "canary", ...over }), instance({ _id: "org_template_instances_stable", instance_key: "key-stable", instance: "acme-stable" })],
    devices: [{ _id: "devices_mbp", user_id: DANA, device_id: "dev-mbp", label: "MacBook", last_seen: Date.now(), local_project_roots: ["/src/acme"], platform: "darwin" }],
  });
  test("only the publisher rolls out, and only with a canary release", async () => {
    await expect(performRollout(ctx(withCanary()), DANA, { template_id: "growth" })).rejects.toThrow(/Forbidden/);
    await expect(performRollout(ctx(fixtures()), ME, { template_id: "growth" })).rejects.toThrow(/No canary release/);
  });
  test("an instance that follows canary gets the upgrade and its host step queued on its own machine; one on stable is left alone", async () => {
    const db = withCanary();
    expect(await performRollout(ctx(db), ME, { template_id: "growth" })).toEqual({ version: "2.0.1", on_release: 0, queued: 1, already_pending: 0, unreachable: 0 });
    expect((await db.get(INSTANCE)).pending_upgrade).toMatchObject({ to: "2.0.1", digest: D2, accepted_by: ME });
    expect((await db.get("org_template_instances_stable")).pending_upgrade).toBeUndefined();
    const commands = await db.query("daemon_commands").collect();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ user_id: DANA, command: "org_template_bind", target_device_id: "dev-mbp" });
    expect(JSON.parse(commands[0].args)).toMatchObject({ instance: "acme-growth", dir: "/src/acme", secrets: [] });
    expect((await db.query("org_changes").collect()).map((c: any) => c.kind)).toEqual(["upgrade"]);
    // Asking again while the host step is pending queues nothing new.
    expect(await performRollout(ctx(db), ME, { template_id: "growth" })).toMatchObject({ queued: 0, already_pending: 1 });
    expect(await db.query("daemon_commands").collect()).toHaveLength(1);
  });
  test("the host's bind lands the release: the upgrade stops waiting and the row's time on the release starts", async () => {
    const db = withCanary();
    await performRollout(ctx(db), ME, { template_id: "growth" });
    const row = await performUpsertInstance(ctx(db), DANA, { instance_key: "key-acme", instance: "acme-growth", template_id: "growth", version: "2.0.1", digest: D2, project_id: P as any, role_id: ROLE as any, phase: "ready" });
    expect(row.pending_upgrade).toBeUndefined();
    expect(row.version_at).not.toBe(NOW - 9 * DAY);
    expect(await performRollout(ctx(db), ME, { template_id: "growth" })).toMatchObject({ on_release: 1, queued: 0 });
  });
  test("an instance with no machine to run on is counted, and keeps its pending upgrade for the next bind", async () => {
    const db = withCanary();
    await db.delete("devices_mbp");
    expect(await performRollout(ctx(db), ME, { template_id: "growth" })).toMatchObject({ queued: 0, unreachable: 1 });
    expect((await db.get(INSTANCE)).pending_upgrade).toMatchObject({ to: "2.0.1" });
  });
});
