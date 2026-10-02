import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { processPushEvent } from "./githubWebhooks";
import { markDeploy } from "./changesDeploy";

// Release and deploy signals for the Changes page (spec 7.3): a version tag
// push becomes a `release` event and `cast ship mark` a `deploy` event, both
// on the repository's team.

const TEAM = "team_1" as any;
const OTHER = "team_2" as any;
const REPO = "codecast-sh/codecast";
const SHA = "ca172db32aa0e4b1c0de5e1f00d2a7c3b4e5f601";
const TOKEN = "cast_ship_token";
const ME = "user_me";

async function seed(extra: Record<string, any[]> = {}) {
  return {
    users: [{ _id: ME, name: "me" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    github_app_installations: [
      { _id: "inst_1", team_id: TEAM, installation_id: 7, account_login: "codecast-sh", repository_selection: "all" },
    ],
    repo_sources: [],
    external_events: [],
    commits: [],
    pull_requests: [],
    ...extra,
  } as Record<string, any[]>;
}

const ctxFor = (tables: Record<string, any[]>) =>
  ({ db: makeFakeDb(tables), auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } }) as any;

function tagPush(ref: string, extra: Record<string, any> = {}) {
  return {
    ref,
    before: "0".repeat(40),
    after: "a".repeat(40),
    created: true,
    deleted: false,
    commits: [],
    head_commit: { id: SHA, message: "chore(cli): bump version to 1.1.163" },
    repository: { full_name: "Codecast-SH/Codecast" },
    pusher: { name: "ashot" },
    sender: { login: "ashot", avatar_url: "https://avatars/ashot" },
    ...extra,
  };
}

async function pushTag(payload: any, tables?: Record<string, any[]>) {
  const t = tables ?? (await seed());
  t.github_webhook_events = [
    { _id: "event_1", delivery_id: "d1", event_type: "push", payload: JSON.stringify(payload), processed: false, created_at: 1_700_000_000_000 },
  ];
  const result = await (processPushEvent as any)._handler(ctxFor(t), { event_id: "event_1" });
  return { result, tables: t };
}

describe("tag pushes", () => {
  test("a version tag records one release on the repository's team", async () => {
    const { result, tables } = await pushTag(tagPush("refs/tags/cli-v1.1.163"));
    expect(result).toEqual({ success: true, reason: "Tag recorded as a release", commits_created: 0 });
    expect(tables.external_events).toHaveLength(1);
    expect(tables.external_events[0]).toMatchObject({
      team_id: TEAM,
      source: "github",
      repository: REPO,
      kind: "release",
      title: "cli-v1.1.163",
      // The commit the tag points at, not the annotated tag object.
      sha: SHA,
      actor_login: "ashot",
      url: "https://github.com/codecast-sh/codecast/releases/tag/cli-v1.1.163",
      meta: { tag: "cli-v1.1.163", surface: "cli", version: "1.1.163" },
      created_at: 1_700_000_000_000,
    });
    expect(tables.commits).toHaveLength(0);
  });

  test("a redelivered tag push is still one release", async () => {
    const tables = await seed();
    await pushTag(tagPush("refs/tags/v2.0.0"), tables);
    await pushTag(tagPush("refs/tags/v2.0.0"), tables);
    expect(tables.external_events).toHaveLength(1);
    expect(tables.external_events[0].meta).toEqual({ tag: "v2.0.0", surface: "release", version: "2.0.0" });
  });

  test("a deleted tag, a versionless tag and an uninstalled repository record nothing", async () => {
    expect((await pushTag(tagPush("refs/tags/v1.0.0", { deleted: true, head_commit: null }))).result.reason).toBe("Tag deleted");
    expect((await pushTag(tagPush("refs/tags/latest"))).result.reason).toBe("Tag names no version");
    const none = await pushTag(tagPush("refs/tags/v1.0.0"), await seed({ github_app_installations: [] }));
    expect(none.result.reason).toBe("No installation for this repository");
    expect(none.tables.external_events).toHaveLength(0);
  });

  test("a lightweight tag with no head commit falls back to after", async () => {
    const { tables } = await pushTag(tagPush("refs/tags/desktop/1.1.123", { head_commit: null }));
    expect(tables.external_events[0].sha).toBe("a".repeat(40));
    expect(tables.external_events[0].url).toBe("https://github.com/codecast-sh/codecast/releases/tag/desktop/1.1.123");
  });
});

describe("markDeploy", () => {
  const mark = (tables: Record<string, any[]>, args: Record<string, unknown>) =>
    (markDeploy as any)._handler(ctxFor(tables), { api_token: TOKEN, repository: REPO, surface: "backend", sha: SHA, ...args });

  test("records a deploy on the installation's team", async () => {
    const tables = await seed();
    const result = await mark(tables, { repository: "Codecast-SH/Codecast.git", surface: "Backend", version: " 0.4.0 " });
    expect(result).toMatchObject({ ok: true, team_id: TEAM, repository: REPO, surface: "backend", sha: SHA, version: "0.4.0" });
    expect(tables.external_events).toHaveLength(1);
    expect(tables.external_events[0]).toMatchObject({
      team_id: TEAM,
      source: "codecast",
      repository: REPO,
      kind: "deploy",
      actor_user_id: ME,
      title: "backend 0.4.0 at ca172db",
      sha: SHA,
      meta: { surface: "backend", version: "0.4.0" },
    });
  });

  test("a repeat mark of the running sha is one marker, however late and however spelled", async () => {
    const tables = await seed();
    const realNow = Date.now;
    try {
      Date.now = () => 1_700_000_059_900;
      const first = await mark(tables, {});
      Date.now = () => 1_700_000_060_100;
      const again = await mark(tables, { repository: "Codecast-SH/Codecast" });
      expect(again.event_id).toBe(first.event_id);
    } finally {
      Date.now = realNow;
    }
    expect(tables.external_events).toHaveLength(1);
  });

  test("a rollback to an earlier sha and another surface each get a marker", async () => {
    const tables = await seed();
    const OLDER = "b".repeat(40);
    let clock = 1_700_000_000_000;
    const realNow = Date.now;
    try {
      Date.now = () => (clock += 1000);
      await mark(tables, {});
      await mark(tables, { sha: OLDER });
      await mark(tables, {});
      await mark(tables, { surface: "web" });
    } finally {
      Date.now = realNow;
    }
    expect(tables.external_events.map((e) => [e.meta.surface, e.sha])).toEqual([
      ["backend", SHA],
      ["backend", OLDER],
      ["backend", SHA],
      ["web", SHA],
    ]);
  });

  test("without an installation team, the one team publishing a checkout", async () => {
    const tables = await seed({
      github_app_installations: [],
      team_memberships: [{ _id: "m2", user_id: ME, team_id: OTHER, role: "member" }],
      repo_sources: [{ _id: "rs1", user_id: "user_mate", team_id: OTHER, repository: REPO, root: "/r", enabled: true }],
    });
    expect((await mark(tables, {})).team_id).toBe(OTHER);
  });

  test("two candidate teams ask for --team, and --team is honored", async () => {
    const tables = await seed({
      github_app_installations: [],
      team_memberships: [
        { _id: "m1", user_id: ME, team_id: TEAM, role: "member" },
        { _id: "m2", user_id: ME, team_id: OTHER, role: "member" },
      ],
      repo_sources: [
        { _id: "rs1", user_id: ME, team_id: TEAM, repository: REPO, root: "/a", enabled: true },
        { _id: "rs2", user_id: ME, team_id: OTHER, repository: REPO, root: "/b", enabled: true },
      ],
    });
    await expect(mark(tables, {})).rejects.toThrow("pass --team");
    expect((await mark(tables, { team_id: OTHER })).team_id).toBe(OTHER);
  });

  test("a non-member is refused, for the derived team and for an explicit one", async () => {
    const tables = await seed({ team_memberships: [] });
    await expect(mark(tables, {})).rejects.toThrow("None of your teams");
    await expect(mark(tables, { team_id: TEAM })).rejects.toThrow("team membership required");
    expect(tables.external_events).toHaveLength(0);
  });

  test("no token, a bad sha, a bad surface or a bad repository is refused", async () => {
    const tables = await seed();
    await expect(mark(tables, { api_token: "wrong" })).rejects.toThrow();
    await expect(mark(tables, { sha: "HEAD" })).rejects.toThrow("not a commit sha");
    await expect(mark(tables, { surface: "back end" })).rejects.toThrow("not a surface name");
    await expect(mark(tables, { repository: "codecast" })).rejects.toThrow("not an owner/name");
    expect(tables.external_events).toHaveLength(0);
  });
});
