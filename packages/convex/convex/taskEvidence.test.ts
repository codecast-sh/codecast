// Evidence attaches at the station (docs/architecture/the-line.md L6): a
// publish with --task stamps the task and its station, a publish from a bound
// session attaches without a flag, a handoff attaches an existing page by
// slug, and tasks.evidence returns one object the task page renders. Driven
// through the handlers against the fake db.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { attachFromCLI, upsertFromPublish } from "./artifacts";
import { computeTaskEvidence, get, prUrlFromComments, resolveEvidenceBinding } from "./taskEvidence";

const OWNER = "users_owner" as any;
const MATE = "users_mate" as any;
const STRANGER = "users_stranger" as any;
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const T1 = "tasks_t1";
const PLAN = "plans_pl1";
const S1 = "conversations_s1";
const TOKEN_OWNER = "owner-token";
const TOKEN_MATE = "mate-token";
const TOKEN_STRANGER = "stranger-token";
const NOW = 1_800_000_000_000;

async function fixtures(extra: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: [
      { _id: OWNER, name: "Owner" },
      { _id: MATE, name: "Mate" },
      { _id: STRANGER, name: "Stranger" },
    ],
    api_tokens: [
      { _id: "tok_owner", user_id: OWNER, token_hash: await hashToken(TOKEN_OWNER) },
      { _id: "tok_mate", user_id: MATE, token_hash: await hashToken(TOKEN_MATE) },
      { _id: "tok_stranger", user_id: STRANGER, token_hash: await hashToken(TOKEN_STRANGER) },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: OWNER, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    plans: [{ _id: PLAN, user_id: OWNER, team_id: TEAM, workspace: WS, short_id: "pl-1", title: "Launch", status: "active", created_at: 1, updated_at: 1 }],
    tasks: [
      {
        _id: T1, user_id: OWNER, team_id: TEAM, workspace: WS, plan_id: PLAN, short_id: "ct-1", title: "Ship the report",
        status: "in_progress", conversation_ids: [S1],
        files_changed: ["a.ts", "b.ts"], verification_evidence: "bun test green", execution_status: "done",
        review_verdict: { verdict: "approve", at: NOW - 1, by_conversation_id: "conversations_reviewer" },
        created_at: 1, updated_at: NOW,
      },
    ],
    conversations: [
      { _id: S1, user_id: OWNER, team_id: TEAM, is_private: false, status: "active", title: "Hand", short_id: "jx1", active_task_id: T1, updated_at: NOW, created_at: 1, message_count: 1 },
    ],
    artifacts: [
      // Already published from this path: a republish with --task attaches it.
      { _id: "art_existing", slug: "existing", user_id: OWNER, title: "Old", source_path: "/tmp/report.html", storage_id: "st_old", size: 10, version: 2, content_hash: "h1", created_at: 1, updated_at: 2 },
      // Pages already attached to the task, at two stations.
      { _id: "art_a", slug: "pagea", user_id: OWNER, title: "Analysis", storage_id: "st_a", size: 1, version: 1, task_id: T1, station: "open", thumb_storage_id: "thumb_a", created_at: 1, updated_at: NOW - 30 },
      { _id: "art_b", slug: "pageb", user_id: OWNER, title: "Verification", storage_id: "st_b", size: 1, version: 3, task_id: T1, station: "in_progress", created_at: 1, updated_at: NOW - 10 },
      // A teammate's page, not attached yet.
      { _id: "art_mate", slug: "matepage", user_id: MATE, title: "Mate's page", storage_id: "st_m", size: 1, version: 1, created_at: 1, updated_at: 3 },
    ],
    docs: [
      { _id: "docs_d1", user_id: OWNER, team_id: TEAM, workspace: WS, title: "Design", doc_type: "note", task_ids: [T1], content: "# Design", created_at: 1, updated_at: NOW - 5 },
      { _id: "docs_d2", user_id: OWNER, team_id: TEAM, workspace: WS, title: "Archived", doc_type: "note", task_ids: [T1], archived_at: 5, content: "", created_at: 1, updated_at: NOW - 4 },
      { _id: "docs_d3", user_id: OWNER, team_id: TEAM, workspace: WS, title: "Unrelated", doc_type: "note", content: "", created_at: 1, updated_at: NOW - 3 },
    ],
    conversation_images: [
      { _id: "ci1", conversation_id: S1, image_key: "k1", src: "https://img/1.png", message_id: "msg1", seq: 0, timestamp: NOW - 20 },
      { _id: "ci2", conversation_id: S1, image_key: "k2", storage_id: "st_img2", message_id: "msg2", seq: 0, timestamp: NOW - 10 },
    ],
    task_comments: [
      { _id: "tc1", task_id: T1, user_id: OWNER, text: "Handoff: done\n\nchecked\n\nPR: https://github.com/acme/growth/pull/7", comment_type: "review", created_at: NOW - 2 },
      { _id: "tc0", task_id: T1, user_id: OWNER, text: "Handoff: done\n\nPR: https://github.com/acme/growth/pull/6", comment_type: "review", created_at: NOW - 9 },
    ],
    artifact_assets: [],
    artifact_versions: [],
    ...extra,
  });
  const ctx = {
    db,
    auth: { getUserIdentity: async () => null },
    storage: { getUrl: async (id: string) => `https://storage/${id}`, delete: async () => {} },
    scheduler: { runAfter: async () => null },
    runMutation: async () => null,
  } as any;
  return { ctx, db };
}

const publishArgs = (extra: Record<string, any> = {}) => ({
  user_id: OWNER,
  storage_id: "st_new",
  title: "Report",
  size: 5,
  content_hash: "h2",
  kind: "html",
  slug: "fresh",
  owner_key: "ok",
  ...extra,
});

describe("L6 evidence binding at publish", () => {
  test("--task stamps task_id, the task's plan and its current station", async () => {
    const { ctx } = await fixtures();
    const resolved = await resolveEvidenceBinding(ctx, OWNER, { task: "ct-1" });
    expect(resolved.error).toBeNull();
    expect(resolved.binding).toMatchObject({ task_id: T1, plan_id: PLAN, station: "in_progress", task_short_id: "ct-1" });
    const result = await (upsertFromPublish as any)._handler(ctx, publishArgs({ source_path: "/tmp/new.html", ...resolved.binding }));
    expect(result.updated).toBe(false);
    const row = await ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", "fresh")).first();
    expect(row).toMatchObject({ task_id: T1, plan_id: PLAN, station: "in_progress" });
  });

  test("a republish with --task attaches the existing page; a republish without one leaves it attached", async () => {
    const { ctx } = await fixtures();
    const { binding } = await resolveEvidenceBinding(ctx, OWNER, { task: "ct-1" });
    await (upsertFromPublish as any)._handler(ctx, publishArgs({ source_path: "/tmp/report.html", ...binding }));
    const row = await ctx.db.get("art_existing");
    expect(row).toMatchObject({ task_id: T1, station: "in_progress", version: 3 });
    // Unchanged bytes, no flags: the attachment stays.
    await (upsertFromPublish as any)._handler(ctx, publishArgs({ source_path: "/tmp/report.html", content_hash: row.content_hash }));
    expect(await ctx.db.get("art_existing")).toMatchObject({ task_id: T1, station: "in_progress", version: 3 });
  });

  test("--plan alone attaches to the plan; a publish from a bound session attaches to its active task without a flag", async () => {
    const { ctx } = await fixtures();
    const plan = await resolveEvidenceBinding(ctx, OWNER, { plan: "pl-1" });
    expect(plan.binding).toEqual({ plan_id: PLAN, plan_short_id: "pl-1" });
    const bound = await resolveEvidenceBinding(ctx, OWNER, { session_conversation_id: S1 });
    expect(bound.binding).toMatchObject({ task_id: T1, plan_id: PLAN, station: "in_progress" });
    // A session bound to nothing attaches nothing.
    const free = await resolveEvidenceBinding(ctx, OWNER, { session_conversation_id: "conversations_none" });
    expect(free.binding).toEqual({});
  });

  test("an unknown task, or one the publisher cannot read, is an error and stamps nothing", async () => {
    const { ctx } = await fixtures();
    expect((await resolveEvidenceBinding(ctx, OWNER, { task: "ct-999" })).error).toBe("Task not found: ct-999");
    expect((await resolveEvidenceBinding(ctx, STRANGER, { task: "ct-1" })).error).toBe("Task not found: ct-1");
    expect((await resolveEvidenceBinding(ctx, STRANGER, { plan: "pl-1" })).error).toBe("Plan not found: pl-1");
  });
});

describe("L6 cast task handoff --page (artifacts.attachFromCLI)", () => {
  test("the owner attaches a page by slug at the task's current station", async () => {
    const { ctx } = await fixtures();
    const r = await (attachFromCLI as any)._handler(ctx, { api_token: TOKEN_OWNER, slug: "existing", task: "ct-1" });
    expect(r).toMatchObject({ ok: true, slug: "existing", task: "ct-1", station: "in_progress" });
    expect(await ctx.db.get("art_existing")).toMatchObject({ task_id: T1, plan_id: PLAN, station: "in_progress" });
  });

  test("a teammate with task access attaches the owner's page; a stranger is refused", async () => {
    const { ctx } = await fixtures();
    const mate = await (attachFromCLI as any)._handler(ctx, { api_token: TOKEN_MATE, slug: "existing", task: "ct-1", station: "in_review" });
    expect(mate).toMatchObject({ ok: true, station: "in_review" });
    const stranger = await (attachFromCLI as any)._handler(ctx, { api_token: TOKEN_STRANGER, slug: "matepage", task: "ct-1" });
    expect(stranger.error).toMatch(/No page/);
    expect(await ctx.db.get("art_mate")).not.toHaveProperty("task_id");
  });

  test("an unknown slug or task is an error", async () => {
    const { ctx } = await fixtures();
    expect((await (attachFromCLI as any)._handler(ctx, { api_token: TOKEN_OWNER, slug: "nope", task: "ct-1" })).error).toMatch(/No page/);
    expect((await (attachFromCLI as any)._handler(ctx, { api_token: TOKEN_OWNER, slug: "existing", task: "ct-77" })).error).toBe("Task not found: ct-77");
  });
});

describe("L6 tasks.evidence (taskEvidence.get)", () => {
  test("pages grouped by station with thumbnails, docs naming the task, session images, handoff fields, PR and verdict", async () => {
    const { ctx } = await fixtures();
    const ev = (await (get as any)._handler(ctx, { api_token: TOKEN_OWNER, task_id: "ct-1" }))!;
    expect(ev.task).toEqual({ id: T1, short_id: "ct-1", station: "in_progress" });
    expect(ev.pages.map((p: any) => p.slug)).toEqual(["pageb", "pagea"]);
    expect(ev.pages[1]).toMatchObject({ title: "Analysis", version: 1, station: "open", thumbnail_url: "https://storage/thumb_a", href: "/a/pagea" });
    expect(ev.pages[0].thumbnail_url).toBeNull();
    expect(ev.stations.map((s: any) => [s.station, s.pages.map((p: any) => p.slug)])).toEqual([["in_progress", ["pageb"]], ["open", ["pagea"]]]);
    expect(ev.docs.map((d: any) => d.id)).toEqual(["docs_d1"]);
    expect(ev.docs[0]).toMatchObject({ title: "Design", href: "/docs/docs_d1" });
    expect(ev.images.map((i: any) => i.url)).toEqual(["https://storage/st_img2", "https://img/1.png"]);
    expect(ev.files_changed).toEqual(["a.ts", "b.ts"]);
    expect(ev.verification_evidence).toBe("bun test green");
    expect(ev.execution_status).toBe("done");
    expect(ev.pr_url).toBe("https://github.com/acme/growth/pull/7");
    expect(ev.review_verdict).toMatchObject({ verdict: "approve", by_conversation_id: "conversations_reviewer" });
  });

  test("a teammate reads it; a stranger gets nothing, and so does an unknown task", async () => {
    const { ctx } = await fixtures();
    expect(await (get as any)._handler(ctx, { api_token: TOKEN_MATE, task_id: "ct-1" })).not.toBeNull();
    expect(await (get as any)._handler(ctx, { api_token: TOKEN_STRANGER, task_id: "ct-1" })).toBeNull();
    expect(await (get as any)._handler(ctx, { api_token: TOKEN_OWNER, task_id: "ct-404" })).toBeNull();
    expect(await (get as any)._handler(ctx, { task_id: "ct-1" })).toBeNull();
  });

  test("a linked session that is private to its owner shows a teammate no images and no session docs", async () => {
    const S2 = "conversations_s2";
    const { ctx } = await fixtures({
      conversations: [
        { _id: S1, user_id: OWNER, team_id: TEAM, is_private: false, status: "active", title: "Hand", short_id: "jx1", active_task_id: T1, updated_at: NOW, created_at: 1, message_count: 1 },
        // Private to the owner: a teammate cannot open it, so its images and docs are not the team's evidence.
        { _id: S2, user_id: OWNER, team_id: TEAM, is_private: true, status: "active", title: "Secret", short_id: "jx2", updated_at: NOW, created_at: 1, message_count: 1 },
      ],
      tasks: [{ _id: T1, user_id: OWNER, team_id: TEAM, workspace: WS, short_id: "ct-1", title: "Ship", status: "in_progress", conversation_ids: [S1, S2], created_at: 1, updated_at: NOW }],
      conversation_images: [
        { _id: "ci1", conversation_id: S1, image_key: "k1", src: "https://img/1.png", message_id: "msg1", seq: 0, timestamp: NOW - 20 },
        { _id: "ci2", conversation_id: S2, image_key: "k2", src: "https://img/secret.png", message_id: "msg2", seq: 0, timestamp: NOW - 10 },
      ],
      docs: [
        { _id: "docs_secret", user_id: OWNER, team_id: TEAM, workspace: `user:${OWNER}`, conversation_id: S2, title: "Secret notes", doc_type: "note", task_ids: [T1], content: "", created_at: 1, updated_at: NOW - 5 },
      ],
      artifacts: [], task_comments: [],
    });
    const mate = (await (get as any)._handler(ctx, { api_token: TOKEN_MATE, task_id: "ct-1" }))!;
    expect(mate.images.map((i: any) => i.url)).toEqual(["https://img/1.png"]);
    expect(mate.docs).toEqual([]);
    // The same rule cast task show applies: a private session sits in its
    // owner's personal workspace, not the team's, so a team task does not
    // list it even for the owner.
    const owner = (await (get as any)._handler(ctx, { api_token: TOKEN_OWNER, task_id: "ct-1" }))!;
    expect(owner.images.map((i: any) => i.url)).toEqual(["https://img/1.png"]);
    expect(owner.docs).toEqual([]);
  });

  test("a session that only commented on the task is linked too, so its images count", async () => {
    const S3 = "conversations_s3";
    const { ctx } = await fixtures({
      conversations: [
        { _id: S1, user_id: OWNER, team_id: TEAM, is_private: false, status: "active", title: "Hand", short_id: "jx1", updated_at: NOW, created_at: 1, message_count: 1 },
        { _id: S3, user_id: MATE, team_id: TEAM, is_private: false, status: "active", title: "Reporter", short_id: "jx3", updated_at: NOW, created_at: 1, message_count: 1 },
      ],
      conversation_images: [
        { _id: "ci3", conversation_id: S3, image_key: "k3", src: "https://img/3.png", message_id: "msg3", seq: 0, timestamp: NOW - 1 },
      ],
      task_comments: [{ _id: "tc3", task_id: T1, user_id: MATE, conversation_id: S3, text: "progress", comment_type: "progress", created_at: NOW - 2 }],
    });
    const ev = (await (get as any)._handler(ctx, { api_token: TOKEN_OWNER, task_id: "ct-1" }))!;
    expect(ev.images.map((i: any) => i.url)).toEqual(["https://img/3.png"]);
  });

  test("a task with no evidence yet answers empty lists, not an error", async () => {
    const { ctx } = await fixtures({
      tasks: [{ _id: T1, user_id: OWNER, workspace: `user:${OWNER}`, short_id: "ct-1", title: "Bare", status: "open", created_at: 1, updated_at: 1 }],
      artifacts: [], docs: [], conversation_images: [], task_comments: [],
    });
    const task = await ctx.db.get(T1);
    const ev = await computeTaskEvidence(ctx, OWNER, task);
    expect(ev).toMatchObject({ pages: [], stations: [], docs: [], images: [], files_changed: [], verification_evidence: null, pr_url: null, review_verdict: null, execution_status: null });
  });

  test("the PR is the newest handoff comment's PR line", () => {
    expect(prUrlFromComments([
      { text: "PR: https://x/1", created_at: 1 },
      { text: "no pr here", created_at: 3 },
      { text: "Handoff: done\n\nPR: https://x/2", created_at: 2 },
    ])).toBe("https://x/2");
    expect(prUrlFromComments([])).toBeNull();
  });
});
