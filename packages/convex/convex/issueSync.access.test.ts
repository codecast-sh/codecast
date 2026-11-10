// Who may register an issue source, and whose webhooks reach it. A source row
// is keyed by the container's name alone, so both doors check the connection.
import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { addSource, importSource, onGithubIssue } from "./issueSync";
import { githubDeliveryServesSource, linearDeliveryServesSource } from "./lib/issueSyncAccess";
import { listIssuesPage } from "./githubIssuesApi";

const REPO = "acme/secret";
const INSTALL_A = { _id: "inst_a", team_id: "team_a", installation_id: 7, account_login: "acme", account_type: "Organization", repository_selection: "all" };
const sourceIn = (team: string, over: Record<string, any> = {}) => ({
  _id: "src_1", provider: "github", kind: "github_repo", external_id: REPO, project_id: "proj_1",
  user_id: "user_b", team_id: team, workspace: `team:${team}`, status: "active", auto_spawn: false, push_new_tasks: false, ...over,
});

function world(seed: Record<string, any[]> = {}, user: string | null = "user_b") {
  const scheduled: any[] = [];
  const tables: Record<string, any[]> = {
    users: [{ _id: "user_a", active_team_id: "team_a" }, { _id: "user_b", active_team_id: "team_b" }],
    teams: [{ _id: "team_a" }, { _id: "team_b" }],
    team_memberships: [{ _id: "m_a", user_id: "user_a", team_id: "team_a" }, { _id: "m_b", user_id: "user_b", team_id: "team_b" }],
    github_app_installations: [INSTALL_A],
    github_webhook_events: [],
    issue_sync_sources: [],
    directory_team_mappings: [],
    app_installations: [],
    projects: [],
    tasks: [],
    ...seed,
  };
  const db: any = makeFakeDb(tables);
  return {
    tables,
    scheduled,
    ctx: {
      db,
      auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
      scheduler: { async runAfter(_ms: number, fn: any, args: any) { scheduled.push({ fn, args }); } },
    } as any,
  };
}

const delivery = (installationId: number | undefined) => ({
  action: "opened",
  ...(installationId === undefined ? {} : { installation: { id: installationId } }),
  repository: { full_name: REPO },
  sender: { login: "ada", type: "User" },
  issue: { id: 1, node_id: "I_1", number: 5, title: "Leak", body: "private", state: "open", html_url: `https://github.com/${REPO}/issues/5`, labels: [], updated_at: "2026-09-01T10:00:00Z", created_at: "2026-09-01T10:00:00Z" },
});

describe("an inbound GitHub delivery", () => {
  test("from another team's installation is dropped: nothing is filed into the workspace that registered the name", async () => {
    const w = world({
      issue_sync_sources: [sourceIn("team_b")],
      github_webhook_events: [{ _id: "evt_1", payload: JSON.stringify(delivery(7)), event_type: "issues", action: "opened" }],
    });
    expect(await (onGithubIssue as any)._handler(w.ctx, { event_id: "evt_1" })).toEqual({ skipped: "foreign_installation" });
    expect(w.tables.tasks).toEqual([]);
    expect(w.tables.issue_sync_sources[0].last_webhook_at).toBeUndefined();
  });

  test("is served only by the source workspace's installation or its adder's own", async () => {
    const w = world();
    // The installation's team is the source's workspace.
    expect(await githubDeliveryServesSource(w.ctx, sourceIn("team_a") as any, delivery(7), REPO)).toBe(true);
    // Another team's installation, an unknown one, and a delivery naming none.
    expect(await githubDeliveryServesSource(w.ctx, sourceIn("team_b") as any, delivery(7), REPO)).toBe(false);
    expect(await githubDeliveryServesSource(w.ctx, sourceIn("team_a") as any, delivery(99), REPO)).toBe(false);
    expect(await githubDeliveryServesSource(w.ctx, sourceIn("team_a") as any, delivery(undefined), REPO)).toBe(false);
    // A personal installation serves the sources its owner added, in any workspace.
    const personal = world({ github_app_installations: [{ _id: "inst_p", scope_user_id: "user_b", installation_id: 8, account_login: "acme", account_type: "User", repository_selection: "all" }] });
    expect(await githubDeliveryServesSource(personal.ctx, sourceIn("team_b") as any, delivery(8), REPO)).toBe(true);
    expect(await githubDeliveryServesSource(personal.ctx, sourceIn("team_b", { user_id: "user_c" }) as any, delivery(8), REPO)).toBe(false);
  });
});

describe("an inbound Linear delivery", () => {
  const src = { ...sourceIn("team_b"), provider: "linear", kind: "linear_team", external_id: "lin_team" } as any;
  test("is served only by the organization the source's connection is for", async () => {
    const w = world({ app_installations: [{ _id: "conn_1", provider: "linear", team_id: "team_b", account_id: "org_b", access_token_enc: "x", granted_scopes: [] }] });
    expect(await linearDeliveryServesSource(w.ctx, src, { organizationId: "org_b" })).toBe(true);
    expect(await linearDeliveryServesSource(w.ctx, src, { organizationId: "org_a" })).toBe(false);
    expect(await linearDeliveryServesSource(world().ctx, src, { organizationId: "org_b" })).toBe(false);
  });
});

describe("adding a source", () => {
  const args = { provider: "github", kind: "github_repo", external_id: REPO, name: REPO };

  test("a source another workspace holds is refused without its ids; its own workspace gets it back", async () => {
    const seed = { issue_sync_sources: [sourceIn("team_a", { user_id: "user_a" })] };
    await expect((addSource as any)._handler(world(seed, "user_b").ctx, args)).rejects.toThrow(/Forbidden/);
    expect(await (addSource as any)._handler(world(seed, "user_a").ctx, args)).toEqual({ id: "src_1", project_id: "proj_1", existing: true });
  });

  test("a repository no installation of the workspace covers is refused, and no row is left behind", async () => {
    const w = world({}, "user_b");
    await expect((addSource as any)._handler(w.ctx, args)).rejects.toThrow(/no github connection in this workspace reaches acme\/secret/);
    expect(w.tables.issue_sync_sources).toEqual([]);
    expect(w.scheduled).toEqual([]);
  });

  test("the team whose installation covers the repository adds it", async () => {
    const w = world({ projects: [{ _id: "proj_9", user_id: "user_a", team_id: "team_a", workspace: "team:team_a", title: "P", short_id: "pj-9" }] }, "user_a");
    const out = await (addSource as any)._handler(w.ctx, { ...args, project_id: "proj_9" });
    expect(out).toMatchObject({ project_id: "proj_9", existing: false });
    expect(w.tables.issue_sync_sources[0]).toMatchObject({ external_id: REPO, workspace: "team:team_a", user_id: "user_a" });
    expect(w.scheduled).toHaveLength(1);
  });
});

describe("a GitHub import page", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const row = (n: number, pr: boolean) => ({ id: n, node_id: `I_${n}`, number: n, title: `t${n}`, body: "", state: "open", html_url: `https://github.com/${REPO}/issues/${n}`, labels: [], comments: 0, updated_at: "2026-09-01T10:00:00Z", created_at: "2026-09-01T10:00:00Z", ...(pr ? { pull_request: {} } : {}) });
  function stubPages(pages: any[][]) {
    const asked: number[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const page = Number(new URL(String(url)).searchParams.get("page") ?? "1");
      asked.push(page);
      return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
    }) as unknown as typeof fetch;
    return asked;
  }

  test("reports the rows GitHub sent beside the issues kept", async () => {
    stubPages([Array.from({ length: 100 }, (_, i) => row(i + 1, i >= 40))]);
    const page = await listIssuesPage("tok", REPO, { page: 1 });
    expect(page.raw).toBe(100);
    expect(page.issues).toHaveLength(40);
  });

  test("a full page that is mostly pull requests does not end the import", async () => {
    const asked = stubPages([Array.from({ length: 100 }, (_, i) => row(i + 1, i > 0)), [row(500, false)]]);
    const applied: any[] = [];
    const synced: any[] = [];
    const ctx = {
      async runQuery(ref: any) {
        const name = getFunctionName(ref);
        if (name.includes("getSource")) return sourceIn("team_a");
        if (name.includes("getInstallationForRepoInTeam")) return { installation_id: 7 };
        throw new Error("unexpected query " + name);
      },
      async runAction(ref: any) {
        const name = getFunctionName(ref);
        if (name.includes("getInstallationToken")) return { token: "tok" };
        throw new Error("unexpected action " + name);
      },
      async runMutation(ref: any, a: any) {
        const name = getFunctionName(ref);
        if (name.includes("applyRemote")) { applied.push(a.issue.number); return {}; }
        if (name.includes("markSourceSynced")) { synced.push(a); return null; }
        throw new Error("unexpected mutation " + name);
      },
      scheduler: { async runAfter() { throw new Error("no continuation expected"); } },
    } as any;
    expect(await (importSource as any)._handler(ctx, { source_id: "src_1" })).toEqual({ applied: 2 });
    expect(asked).toEqual([1, 2]);
    expect(applied).toEqual([1, 500]);
    expect(synced).toEqual([{ source_id: "src_1" }]);
  });

  test("a listing longer than one run continues from the next page and is not stamped synced yet", async () => {
    const asked = stubPages(Array.from({ length: 12 }, (_, p) => Array.from({ length: 100 }, (_, i) => row(p * 100 + i + 1, true))));
    const scheduled: any[] = [];
    const synced: any[] = [];
    const ctx = {
      async runQuery(ref: any) { return getFunctionName(ref).includes("getSource") ? sourceIn("team_a") : { installation_id: 7 }; },
      async runAction() { return { token: "tok" }; },
      async runMutation(ref: any, a: any) { if (getFunctionName(ref).includes("markSourceSynced")) synced.push(a); return {}; },
      scheduler: { async runAfter(_ms: number, _fn: any, a: any) { scheduled.push(a); } },
    } as any;
    await (importSource as any)._handler(ctx, { source_id: "src_1" });
    expect(asked).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(scheduled).toEqual([{ source_id: "src_1", since: undefined, page: 11, hop: 1 }]);
    expect(synced).toEqual([]);
  });
});
