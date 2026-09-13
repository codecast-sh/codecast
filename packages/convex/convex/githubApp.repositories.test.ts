// GitHub's `installation_repositories` delivery is how codecast learns that a
// person changed which repositories the App may see on GitHub's settings
// page. The handler used to be an empty branch, so an install that gained a
// repository kept its old list and every "not in this workspace" answer stood
// until someone reinstalled. The row must follow the delivery, and the
// caller must learn which team to backfill and for which repositories.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { applyInstallationRepositoriesEvent, backfillInstallationPulls } from "./githubApp";

const repo = (id: number, full_name: string) => ({ id, name: full_name.split("/")[1], full_name });

function install(overrides: Record<string, any> = {}) {
  return {
    _id: "i1",
    team_id: "team_union",
    installation_id: 42,
    account_login: "union-ai",
    repository_selection: "selected",
    repositories: [repo(1, "union-ai/union-web")],
    ...overrides,
  };
}

describe("applyInstallationRepositoriesEvent", () => {
  test("an added repository joins the stored list and is named for the backfill", async () => {
    const db = makeFakeDb({ github_app_installations: [install()] });
    const result = await (applyInstallationRepositoriesEvent as any)._handler({ db }, {
      installation_id: 42,
      repository_selection: "selected",
      added: [repo(2, "Union-AI/Union-Mobile")],
      removed: [],
    });
    expect(result).toEqual({ team_id: "team_union", added: ["union-ai/union-mobile"] });
    const patch = db._patched[0].patch;
    expect(patch.repositories.map((r: any) => r.full_name)).toEqual(["union-ai/union-web", "Union-AI/Union-Mobile"]);
    expect(patch.last_webhook_at).toBeGreaterThan(0);
  });

  test("a removed repository leaves the list; a redelivered add does not duplicate", async () => {
    const db = makeFakeDb({
      github_app_installations: [install({ repositories: [repo(1, "union-ai/union-web"), repo(2, "union-ai/union-mobile")] })],
    });
    await (applyInstallationRepositoriesEvent as any)._handler({ db }, {
      installation_id: 42,
      added: [repo(2, "union-ai/union-mobile")],
      removed: [repo(1, "union-ai/union-web")],
    });
    expect(db._patched[0].patch.repositories.map((r: any) => r.id)).toEqual([2]);
  });

  test("switching to all repositories drops the stored list", async () => {
    const db = makeFakeDb({ github_app_installations: [install()] });
    await (applyInstallationRepositoriesEvent as any)._handler({ db }, {
      installation_id: 42,
      repository_selection: "all",
      added: [repo(2, "union-ai/union-mobile")],
      removed: [],
    });
    expect(db._patched[0].patch.repository_selection).toBe("all");
    expect(db._patched[0].patch.repositories).toBeUndefined();
  });

  test("a personal install answers no team, so nothing is backfilled into one", async () => {
    const db = makeFakeDb({ github_app_installations: [install({ team_id: undefined, scope_user_id: "u1" })] });
    const result = await (applyInstallationRepositoriesEvent as any)._handler({ db }, {
      installation_id: 42,
      added: [repo(2, "union-ai/union-mobile")],
      removed: [],
    });
    expect(result.team_id).toBeNull();
  });

  test("an unknown installation is ignored", async () => {
    const db = makeFakeDb({ github_app_installations: [] });
    const result = await (applyInstallationRepositoriesEvent as any)._handler({ db }, {
      installation_id: 7,
      added: [repo(2, "x/y")],
      removed: [],
    });
    expect(result).toEqual({ team_id: null, added: [] });
    expect(db._patched).toEqual([]);
  });
});

describe("backfillInstallationPulls", () => {
  // The action reads GitHub through internal functions; the harness answers
  // them from a script so the flow can be checked without a network.
  function harness(row: any, pullsByRepo: Record<string, any[]>) {
    const calls: Array<{ kind: string; name: string; args: any }> = [];
    const fnName = (ref: any) => getFunctionName(ref);
    const ctx = {
      runQuery: async (ref: any, args: any) => {
        calls.push({ kind: "query", name: fnName(ref), args });
        return row;
      },
      runAction: async (ref: any, args: any) => {
        const name = fnName(ref);
        calls.push({ kind: "action", name, args });
        if (name.includes("getInstallationToken")) return { token: "tok", expires_at: 0 };
        if (name.includes("listPulls")) {
          return { pulls: args.page === 1 ? (pullsByRepo[args.repository] ?? []).filter((p) => (args.state === "open") === (p.state === "open")) : [] };
        }
        if (name.includes("getPRFiles")) return { files: [], additions: 0, deletions: 0, changed_files: 0, commits_count: 0 };
        throw new Error(`unexpected action ${name}`);
      },
      runMutation: async (ref: any, args: any) => {
        calls.push({ kind: "mutation", name: fnName(ref), args });
        return { pr_id: `pr_${args.number ?? "x"}`, created: true };
      },
      scheduler: { runAfter: async (_ms: number, ref: any, args: any) => { calls.push({ kind: "schedule", name: fnName(ref), args }); } },
    };
    return { ctx, calls };
  }

  const pull = (n: number, state: "open" | "closed") => ({
    id: 1000 + n, number: n, title: `PR ${n}`, body: "", state, draft: false,
    merged_at: null, created_at: 1, updated_at: 2, closed_at: null, author_login: "ada",
    head_ref: `f/${n}`, base_ref: "main", labels: [], html_url: "", requested_reviewers: [],
  });

  test("a team install's selected repositories are read and every pull request is stored with the team", async () => {
    const { ctx, calls } = harness(install(), { "union-ai/union-web": [pull(1, "open"), pull(2, "closed")] });
    const result = await (backfillInstallationPulls as any)._handler(ctx, { installation_id: 42 });
    expect(result).toEqual({ repositories: 1, pulls: 2 });
    const stored = calls.filter((c) => c.kind === "mutation" && c.name.includes("syncPRFromGitHub")).map((c) => c.args);
    expect(stored.map((a) => [a.number, a.state, a.team_id])).toEqual([[2, "closed", "team_union"], [1, "open", "team_union"]]);
    // Only the open one gets files and a merge-state read.
    expect(calls.filter((c) => c.name.includes("getPRFiles")).map((c) => c.args.pr_number)).toEqual([1]);
    expect(calls.filter((c) => c.kind === "schedule").map((c) => c.args.pr_id)).toEqual(["pr_1"]);
    expect(calls.some((c) => c.name.includes("stampInstallationSync") && !c.args.error)).toBe(true);
  });

  test("a narrowed pass reads only the repositories named", async () => {
    const { ctx, calls } = harness(install(), { "union-ai/union-mobile": [pull(3262, "open")] });
    await (backfillInstallationPulls as any)._handler(ctx, { installation_id: 42, repositories: ["union-ai/union-mobile"] });
    const listed = calls.filter((c) => c.name.includes("listPulls")).map((c) => c.args.repository);
    expect(new Set(listed)).toEqual(new Set(["union-ai/union-mobile"]));
  });

  test("a personal or suspended install brings nothing in", async () => {
    for (const row of [install({ team_id: undefined, scope_user_id: "u1" }), install({ suspended_at: 5 })]) {
      const { ctx, calls } = harness(row, {});
      expect(await (backfillInstallationPulls as any)._handler(ctx, { installation_id: 42 })).toEqual({ repositories: 0, pulls: 0 });
      expect(calls.filter((c) => c.kind === "action")).toEqual([]);
    }
  });
});
