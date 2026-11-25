// Codecast's `approval` status (ct-100350): the rule (decide), the status worked out from a mocked GitHub and posted,
// the approvals a person's card and press make or revoke, and the merge as codecast's app.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { decide, evaluate, mechanismOf, mergeAsApp, settle, sweep, type ApprovalFacts } from "./changeApprovals";
import { HOST_TOKEN_PERMISSIONS } from "./githubApp";
import { claimPress, settleCardApproval } from "./lib/changeApprovalRows";
import { processPRSynchronizeEvent } from "./githubWebhooks";
import { merge } from "./prCli";

const REPO = "union-ai/union-mobile";
const HEAD = "a".repeat(40);
const MB = "b".repeat(40);
const needs = { judged: "Jason", mechanism: "an engineer or Ashot" };
const facts = (over: Partial<Extract<ApprovalFacts, { judged: string[] }>> = {}): ApprovalFacts => ({ opted: true, judged: [], mechanism: false, card: null, press: null, needs, ...over });

describe("decide", () => {
  test("a repository not opted in gets nothing", () => expect(decide({ opted: false })).toBeNull());
  test("what could not be read is pending on a person", () => {
    expect(decide({ opted: true, unreadable: "main's judges.txt" })).toEqual({ state: "pending", description: "could not read main's judges.txt; a person approves" });
  });
  test("a Release Captain's revert merges on CI alone, even before any review", () => {
    expect(decide(facts({ captain_revert: true, mechanism: null, judged: ["x"] }))).toEqual({ state: "success", description: "the Release Captain's revert: CI's required checks decide" });
  });
  test("nothing is success before the review's mechanism answer exists", () => {
    expect(decide(facts({ mechanism: null }))).toEqual({ state: "pending", description: "waiting for the review's mechanism answer" });
    expect(decide(facts({ mechanism: null, press: { who: "Jason" }, judged: ["a"] }))?.state).toBe("pending");
  });
  test("no judged path and not a mechanism is success", () => expect(decide(facts())?.state).toBe("success"));
  test("a mechanism waits on an engineer; a person's card covers it, a press does not", () => {
    expect(decide(facts({ mechanism: true, press: { who: "Jason" } }))).toEqual({ state: "pending", description: "needs an engineer or Ashot: the review called it a mechanism" });
    expect(decide(facts({ mechanism: true, card: { who: "Ashot", ref: "sd-9" } }))).toEqual({ state: "success", description: "approved by Ashot (sd-9)" });
  });
  test("judged files: a press or a card for this diff approves, else it names who and what in 140 characters", () => {
    expect(decide(facts({ judged: ["a"], press: { who: "Jason" } }))).toEqual({ state: "success", description: "approved by Jason (Ship press)" });
    const many = Array.from({ length: 30 }, (_, i) => `outreach/line/change/station-${i}.md`);
    const out = decide(facts({ judged: many }))!;
    expect(out.state).toBe("pending");
    expect(out.description.startsWith("needs Jason: edits outreach/line/change/station-0.md")).toBe(true);
    expect(out.description).toMatch(/\(\+\d+\)$/);
    expect(out.description.length).toBeLessThanOrEqual(140);
  });
});

describe("the mechanism answer counts only from a reviewer station codecast saw finish, on this head", () => {
  const run = (station: any, verdict: any = {}) => ({ created_at: 1, node_statuses: [station], review_verdict: { node_id: "review", verdict: "ship", head_sha: HEAD, mechanism: false, at: 5, attempt: 1, ...verdict }, station_rebases: [{ from: HEAD, to: "d".repeat(40), at: 6, attempt: 1 }] });
  const done = { node_id: "review", status: "completed", session_id: "s1", started_at: 2 };
  test("finished, answered, this head or the run's own rebase of it", () => {
    expect(mechanismOf(run(done), HEAD)).toBe(false);
    expect(mechanismOf(run(done), "d".repeat(40))).toBe(false);
  });
  test("still running, not answered, another head: not said", () => {
    expect(mechanismOf(run({ ...done, status: "running" }), HEAD)).toBeNull();
    expect(mechanismOf(run(done, { mechanism: undefined }), HEAD)).toBeNull();
    expect(mechanismOf(run(done), "e".repeat(40))).toBeNull();
  });
});

// ── A mocked GitHub ──

type Route = { method: string; match: RegExp; reply: (url: string, body: any) => { status?: number; json?: any; text?: string } };
let routes: Route[] = [];
let calls: Array<{ method: string; url: string; body: any; auth?: string }> = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  routes = [];
  calls = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, auth: init.headers?.Authorization ?? init.headers?.authorization });
    const route = routes.find((r) => r.method === method && r.match.test(url));
    if (!route) return new Response(`no route for ${method} ${url}`, { status: 599 });
    const r = route.reply(url, body);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

const LAND_PATCH = "@@ -1,2 +1,2 @@\n a\n-b\n+c";
/** A pull request of 250 files: the judged one is on GitHub's third page. */
function github(opts: { judges?: string; statusAfter?: string } = {}) {
  const files = [
    ...Array.from({ length: 249 }, (_, i) => ({ filename: `docs/f${i}.md`, status: "modified", patch: "@@ -1 +1 @@\n-x\n+y", additions: 1, deletions: 1 })),
    { filename: "outreach/line/change/land.cast", status: "modified", patch: LAND_PATCH, additions: 1, deletions: 1 },
  ];
  routes.push(
    { method: "GET", match: /\/pulls\/7$/, reply: () => ({ json: { changed_files: files.length, state: "open", head: { sha: HEAD, ref: "feature" }, base: { ref: "main", repo: { default_branch: "main" } } } }) },
    { method: "GET", match: /\/pulls\/7\/files\?/, reply: (url) => { const page = Number(/[?&]page=(\d+)/.exec(url)![1]); return { json: files.slice((page - 1) * 100, page * 100) }; } },
    { method: "GET", match: /\/contents\/outreach\/line\/change\/judges\.txt\?ref=main/, reply: () => ({ text: opts.judges ?? "# judged\noutreach/line/change/\n" }) },
    { method: "GET", match: /\/contents\/outreach\/line\/change\/owners\.txt/, reply: () => ({ text: "outreach/line/ Ashot\n" }) },
    { method: "GET", match: /\/compare\/main\.\.\./, reply: () => ({ json: { merge_base_commit: { sha: MB } } }) },
    { method: "GET", match: /\/pulls\/7\/commits/, reply: () => ({ json: [{ commit: { message: "Edit land\n\nRequested-by: Samvit" } }] }) },
    { method: "POST", match: /\/graphql$/, reply: (_u, body) => {
      const data: any = {};
      for (const [k, e] of Object.entries(body.variables)) {
        if (!k.startsWith("e")) continue;
        const [, path] = String(e).split(":");
        const dir = path;
        const names = files.filter((f) => f.filename.startsWith(dir ? `${dir}/` : "") && !f.filename.slice(dir ? dir.length + 1 : 0).includes("/")).map((f) => f.filename.split("/").pop());
        data[`o${k.slice(1)}`] = { entries: names.map((name) => ({ name, mode: 0o100644 })) };
      }
      return { json: { data: { repository: data } } };
    } },
    { method: "POST", match: /\/statuses\//, reply: () => ({ status: 201, json: {} }) },
    { method: "GET", match: /\/commits\/[0-9a-f]{40}\/statuses/, reply: () => ({ json: [{ context: "approval (shadow)", state: opts.statusAfter ?? "success" }] }) },
    { method: "PUT", match: /\/pulls\/7\/merge$/, reply: () => ({ json: { merged: true, sha: "f".repeat(40) } }) },
  );
}

const installation = { _id: "inst1", installation_id: 42, account_login: "union-ai", repository_selection: "all", team_id: "team1", approval_gate: [{ repository: REPO, judges_path: "outreach/line/change/judges.txt", mode: "shadow" }] };

/** An action ctx whose internal calls run the real handlers over one fake db. */
function actionCtx(db: any) {
  const scheduled: Array<{ name: string; args: any }> = [];
  const mutCtx = { db, scheduler: { runAfter: async (_ms: number, ref: any, args: any) => { scheduled.push({ name: getFunctionName(ref), args }); } } };
  const ctx: any = {
    scheduler: mutCtx.scheduler,
    runQuery: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "changeApprovals:gateFor") return (await import("./lib/changeApprovalRows")).gateOf({ db }, args.repository);
      if (name === "changeApprovals:openNumbers") return [];
      throw new Error(`unexpected query ${name}`);
    },
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      const mod: any = await import("./changeApprovals");
      if (name === "changeApprovals:settle") return mod.settle._handler(mutCtx, args);
      if (name === "changeApprovals:noteUnposted") return mod.noteUnposted._handler(mutCtx, args);
      throw new Error(`unexpected mutation ${name}`);
    },
    runAction: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "githubApp:getInstallationToken") return { token: "app_tok", expires_at: 0, permissions: { statuses: "write", contents: "write" } };
      if (name === "githubApi:mergePullRequest") return (await import("./githubApi")).mergePullRequest._handler({} as any, args);
      throw new Error(`unexpected action ${name}`);
    },
  };
  return { ctx, scheduled };
}

const prRow = { _id: "pr1", team_id: "team1", repository: REPO, number: 7, state: "open", head_sha: HEAD, title: "t", body: "", github_pr_id: 99, author_github_username: "x", linked_session_ids: [], created_at: 1, updated_at: 1 };

describe("the status from GitHub", () => {
  test("a push re-posts: synchronize schedules the work-out for an opted-in repository", async () => {
    const db = makeFakeDb({ github_app_installations: [installation] });
    const scheduled: string[] = [];
    const ctx: any = {
      runQuery: async (ref: any, args: any) => {
        const name = getFunctionName(ref);
        if (name.endsWith("getWebhookEvent")) return { _id: "ev1", processed: false, payload: JSON.stringify({ pull_request: { id: 99, number: 7, head: { sha: HEAD } }, repository: { full_name: REPO }, sender: {} }) };
        if (name.endsWith("getPRByGithubId")) return prRow;
        if (name === "changeApprovals:gateFor") return (await import("./lib/changeApprovalRows")).gateOf({ db }, args.repository);
        return null;
      },
      runMutation: async () => ({ ok: true }),
      runAction: async () => { throw new Error("no token"); },
      scheduler: { runAfter: async (_ms: number, ref: any, args: any) => { scheduled.push(`${getFunctionName(ref)} ${args.repository}#${args.pr_number}`); } },
    };
    await (processPRSynchronizeEvent as any)._handler(ctx, { event_id: "ev1" });
    expect(scheduled).toContain(`changeApprovals:evaluate ${REPO}#7`);
  });

  test("reads all three pages, finds the judged file on the last, and posts pending naming the asker", async () => {
    github();
    const db = makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [], change_approvals: [], users: [] });
    const { ctx } = actionCtx(db);
    // No run behind it: the review's answer never came, so the status waits on it first.
    const out: any = await (evaluate as any)._handler(ctx, { repository: REPO, pr_number: 7, post: true });
    expect(calls.filter((c) => /\/files\?/.test(c.url)).map((c) => /[?&]page=(\d+)/.exec(c.url)![1])).toEqual(["1", "2", "3"]);
    expect(out).toMatchObject({ state: "pending", description: "waiting for the review's mechanism answer", posted: true, context: "approval (shadow)" });
    const post = calls.find((c) => c.method === "POST" && /statuses/.test(c.url))!;
    expect(post.url).toEndWith(`/repos/${REPO}/statuses/${HEAD}`);
    expect(post.body).toEqual({ state: "pending", description: "waiting for the review's mechanism answer", context: "approval (shadow)" });
    expect(db._tables.pull_requests[0].approval).toMatchObject({ head_sha: HEAD, state: "pending", judged_files: ["outreach/line/change/land.cast"] });
    expect(db._tables.pull_requests[0].approval.judged_key).toMatch(/^[0-9a-f]{40}$/);
  });

  test("with the review's answer in, judged files wait on the Requested-by person", async () => {
    github();
    const run = { _id: "run1", user_id: "agent", created_at: 1, node_statuses: [{ node_id: "review", status: "completed", session_id: "s", started_at: 2 }], review_verdict: { node_id: "review", verdict: "ship", head_sha: HEAD, mechanism: false, at: 3, attempt: 1 }, pr: { repository: REPO, number: 7, first_head_sha: HEAD, head_sha: HEAD, at: 1 } };
    const db = makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [run], change_approvals: [], users: [] });
    const out: any = await (evaluate as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, post: true });
    expect(out).toMatchObject({ state: "pending", description: "needs Samvit: edits outreach/line/change/land.cast" });
  });

  test("a judges file missing on main is pending, never success", async () => {
    github();
    routes = routes.filter((r) => !/judges/.test(String(r.match)));
    routes.unshift({ method: "GET", match: /judges\.txt/, reply: () => ({ status: 404 }) });
    const db = makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [], change_approvals: [], users: [] });
    const out: any = await (evaluate as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, post: true });
    expect(out).toMatchObject({ state: "pending", description: "could not read outreach/line/change/judges.txt on main; a person approves" });
  });

  test("an app without statuses: write records why and posts nothing", async () => {
    github();
    const db = makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [], change_approvals: [], users: [] });
    const { ctx } = actionCtx(db);
    ctx.runAction = async () => ({ token: "app_tok", expires_at: 0, permissions: { contents: "write" } });
    const out: any = await (evaluate as any)._handler(ctx, { repository: REPO, pr_number: 7, post: true });
    expect(out.posted).toBe(false);
    expect(calls.some((c) => /statuses/.test(c.url))).toBe(false);
    expect(db._tables.pull_requests[0].approval).toMatchObject({ state: "unposted", description: expect.stringContaining("statuses: write") });
  });
});

describe("a person's approvals", () => {
  const card = (label: string) => ({ _id: "sd1", short_id: "sd-9", workflow_run_id: "run1", options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }], conversation_id: "c1", task_id: "t1", approval: { repository: REPO, pr_number: 7, judged_key: "k1", files: ["outreach/line/change/land.cast"] }, label });
  const run = { _id: "run1", user_id: "agent", created_at: 1, node_statuses: [], pr: { repository: REPO, number: 7, first_head_sha: HEAD, head_sha: HEAD, at: 1 } };

  test("a person's Ship on the run's card inserts the approval of what the card carried, and re-posts", async () => {
    const db = makeFakeDb({ github_app_installations: [installation], workflow_runs: [run], change_approvals: [] });
    const scheduled: string[] = [];
    const ctx = { db, scheduler: { runAfter: async (_: number, ref: any) => { scheduled.push(getFunctionName(ref)); } } };
    await settleCardApproval(ctx, card("Ship") as any, { status: "answered", answer_index: 0 }, { kind: "user", user_id: "u1" as any }, 10);
    expect(db._inserted.map((i: any) => i.doc)).toEqual([expect.objectContaining({ source: "card", judged_key: "k1", pr_number: 7, user_id: "u1", decision_id: "sd1", workflow_run_id: "run1" })]);
    expect(scheduled).toEqual(["changeApprovals:evaluate"]);
  });

  test("an agent's Ship approves nothing; Approve merge counts as Ship", async () => {
    const db = makeFakeDb({ github_app_installations: [installation], workflow_runs: [run], change_approvals: [] });
    const ctx = { db, scheduler: { runAfter: async () => {} } };
    await settleCardApproval(ctx, card("Ship") as any, { status: "answered", answer_index: 0 }, { kind: "role" }, 10);
    expect(db._inserted).toEqual([]);
    const approveMerge = { ...card("x"), options: [{ label: "Approve merge" }, { label: "Revise" }] };
    await settleCardApproval(ctx, approveMerge as any, { status: "answered", answer_index: 0 }, { kind: "user", user_id: "u1" as any }, 10);
    expect(db._inserted.length).toBe(1);
  });

  test("Revise revokes every approval of the run, the press included", async () => {
    const db = makeFakeDb({ github_app_installations: [installation], workflow_runs: [run], change_approvals: [
      { _id: "a1", repository: REPO, workflow_run_id: "run1", source: "ship_press", files: [], user_id: "u1", created_at: 1 },
      { _id: "a2", repository: REPO, workflow_run_id: "run1", source: "card", files: [], user_id: "u1", created_at: 2 },
    ] });
    await settleCardApproval({ db, scheduler: { runAfter: async () => {} } }, card("Revise") as any, { status: "answered", answer_index: 1 }, { kind: "user", user_id: "u1" as any }, 10);
    expect(db._tables.change_approvals.map((a: any) => a.revoked_at)).toEqual([10, 10]);
  });

  test("a press joins the run its session started, and is tied to the judged diff of the run's first head", async () => {
    const db = makeFakeDb({
      github_app_installations: [installation],
      workflow_runs: [{ ...run, node_statuses: [{ node_id: "review", status: "completed", session_id: "s", started_at: 2 }], review_verdict: { node_id: "review", verdict: "ship", head_sha: HEAD, mechanism: false, at: 3, attempt: 1 } }],
      change_approvals: [{ _id: "p1", repository: REPO, conversation_id: "c1", source: "ship_press", files: ["outreach/line/change/land.cast"], user_id: "u1", created_at: 100 }],
      pull_requests: [prRow],
      users: [{ _id: "u1", name: "Jason" }],
    });
    expect(await claimPress({ db }, "run1" as any, "c1" as any, 200)).toBe("p1" as any);
    expect(db._tables.workflow_runs[0].pressed_approval_id).toBe("p1");
    const ctx = { db, scheduler: { runAfter: async () => {} } };
    const args = { repository: REPO, pr_number: 7, head_sha: HEAD, judged: ["outreach/line/change/land.cast"], key: "k1" };
    expect(await (settle as any)._handler(ctx, args)).toMatchObject({ state: "success", description: "approved by Jason (Ship press)" });
    expect(db._tables.change_approvals[0]).toMatchObject({ pr_number: 7, judged_key: "k1", head_sha: HEAD });
    // A rebase keeps the judged diff, so the key and the approval; a changed judged diff asks the presser again.
    const later = "d".repeat(40);
    db._tables.workflow_runs[0].station_rebases = [{ from: HEAD, to: later, at: 4, attempt: 1 }];
    expect(await (settle as any)._handler(ctx, { ...args, head_sha: later })).toMatchObject({ state: "success" });
    expect(await (settle as any)._handler(ctx, { ...args, head_sha: later, key: "k2" })).toMatchObject({ state: "pending", description: "needs Jason: edits outreach/line/change/land.cast" });
  });
});

describe("merging as codecast's app", () => {
  test("cast pr merge --as-app goes to the app's merge, never the person's token, and never bypasses", async () => {
    const seen: string[] = [];
    const ctx: any = {
      runQuery: async () => ({ user_id: "u1", github_token: "user_tok", github_username: "ashot", pr: { id: "pr1", repository: REPO, number: 7, state: "open", head_ref: "feature" } }),
      runAction: async (ref: any, args: any) => { seen.push(getFunctionName(ref)); expect(JSON.stringify(args)).not.toContain("user_tok"); return { merged: true, sha: "m" }; },
    };
    expect(await (merge as any)._handler(ctx, { number: 7, as_app: true, expected_head_sha: HEAD, commit_title: "T" })).toMatchObject({ merged: true, as: "the codecast app" });
    expect(seen).toEqual(["changeApprovals:mergeAsApp"]);
    expect((await (merge as any)._handler(ctx, { number: 7, as_app: true, bypass: true, expected_head_sha: HEAD })).error).toMatch(/never bypasses/);
    expect((await (merge as any)._handler(ctx, { number: 7, as_app: true })).error).toMatch(/--head/);
    expect(seen.length).toBe(1);
  });

  test("the app merges with its installation token only when its own verdict and GitHub's status both say success", async () => {
    github();
    const card = { _id: "a1", repository: REPO, pr_number: 7, source: "card", files: [], user_id: "u1", created_at: 1 };
    const run = { _id: "run1", user_id: "agent", created_at: 1, node_statuses: [{ node_id: "review", status: "completed", session_id: "s", started_at: 2 }], review_verdict: { node_id: "review", verdict: "ship", head_sha: HEAD, mechanism: false, at: 3, attempt: 1 }, pr: { repository: REPO, number: 7, first_head_sha: HEAD, head_sha: HEAD, at: 1 } };
    // Not approved: refused before any merge call.
    let db = makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [run], change_approvals: [], users: [] });
    let out: any = await (mergeAsApp as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, expected_head_sha: HEAD });
    expect(out.error).toMatch(/^not approved: needs/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    // Approved by a card for this key: merges as the app.
    db = makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [run], change_approvals: [card], users: [{ _id: "u1", name: "Ashot" }] });
    await (evaluate as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, post: false });
    // The card answered on this judged diff: the key codecast worked out for the head.
    db._tables.change_approvals[0].judged_key = db._tables.pull_requests[0].approval.judged_key;
    calls = [];
    out = await (mergeAsApp as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, expected_head_sha: HEAD, commit_title: "Squash", commit_message: "why" });
    expect(out).toMatchObject({ merged: true });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ merge_method: "squash", sha: HEAD, commit_title: "Squash", commit_message: "why" });
    expect(put.auth).toBe("Bearer app_tok");

    // GitHub's status says otherwise: refused.
    routes = routes.filter((r) => !/statuses\//.test(String(r.match)) || r.method === "POST");
    routes.push({ method: "GET", match: /\/commits\/[0-9a-f]{40}\/statuses/, reply: () => ({ json: [{ context: "approval (shadow)", state: "pending" }] }) });
    calls = [];
    out = await (mergeAsApp as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, expected_head_sha: HEAD });
    expect(out.error).toMatch(/status on .* is pending/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("the run behind it", () => {
  const reviewed = { node_statuses: [{ node_id: "review", status: "completed", session_id: "s", started_at: 2 }], review_verdict: { node_id: "review", verdict: "ship", head_sha: HEAD, mechanism: false, at: 3, attempt: 1 } };
  const base = { _id: "run1", user_id: "agent", created_at: 1, task_id: "t1", pr: { repository: REPO, number: 7, first_head_sha: HEAD, head_sha: HEAD, at: 1 }, ...reviewed };
  const ctxOf = (tables: Record<string, any[]>) => ({ db: makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], change_approvals: [], ...tables }), scheduler: { runAfter: async () => {} } });
  const args = { repository: REPO, pr_number: 7, head_sha: HEAD, judged: ["outreach/line/change/land.cast"], key: "k1" };

  test("the Release Captain's revert needs no card; anyone else's revert is judged like any change", async () => {
    const captain = ctxOf({ workflow_runs: [{ ...base, org_role_id: "role1" }], org_roles: [{ _id: "role1", handle: "release", name: "Release Captain" }] });
    expect(await (settle as any)._handler(captain, { ...args, reverts: true })).toMatchObject({ state: "success" });
    const other = ctxOf({ workflow_runs: [{ ...base, org_role_id: "role2" }], org_roles: [{ _id: "role2", handle: "growth", name: "Head of Growth" }] });
    expect(await (settle as any)._handler(other, { ...args, reverts: true })).toMatchObject({ state: "pending" });
  });

  test("for a change Cam asked for, the engineer's yes before the build approves it, and a card would be the engineer's, never Cam's", async () => {
    const users = [{ _id: "cam", name: "Cameron Musgrave" }, { _id: "ash", name: "Ashot" }];
    const yes = (who: string, at: number) => ({ _id: `sd_${who}`, short_id: `sd-${who}`, task_id: "t1", status: "answered", options: [{ label: "Yes" }, { label: "No" }], answer_index: 0, answered_by: { kind: "user", id: who }, resolved_at: at });
    const asked = { ...args, requested_by: "Cameron", area_owner: "Samvit" };
    const later = { ...base, created_at: 100, node_statuses: [{ node_id: "review", status: "completed", session_id: "s", started_at: 102 }], review_verdict: { ...base.review_verdict, attempt: 100 } };
    const approved = ctxOf({ workflow_runs: [later], users, session_decisions: [yes("ash", 50)] });
    expect(await (settle as any)._handler(approved, asked)).toMatchObject({ state: "success", description: "approved by Ashot (sd-ash)" });
    // Cam's own yes, or one given after the build began, is no engineer's pre-build yes; the card names the area's owner.
    const notYet = ctxOf({ workflow_runs: [later], users, session_decisions: [yes("cam", 50), yes("ash", 150)] });
    expect(await (settle as any)._handler(notYet, asked)).toMatchObject({ state: "pending", description: "needs Samvit: edits outreach/line/change/land.cast" });
  });

  test("the same verdict on the same head is not posted again; a new head is", async () => {
    const c = ctxOf({ workflow_runs: [base], users: [] });
    expect((await (settle as any)._handler(c, args)).unchanged).toBe(false);
    expect((await (settle as any)._handler(c, args)).unchanged).toBe(true);
    expect((await (settle as any)._handler(c, { ...args, head_sha: "d".repeat(40) })).unchanged).toBe(false);
  });

  test("the sweep works out every open pull request of each opted-in repository, a few seconds apart", async () => {
    const scheduled: Array<[number, any]> = [];
    const ctx: any = {
      runQuery: async (ref: any, a: any) => (getFunctionName(ref) === "changeApprovals:optedRepositories" ? [REPO] : a.repository === REPO ? [7, 8] : []),
      scheduler: { runAfter: async (ms: number, _ref: any, a: any) => { scheduled.push([ms, a.pr_number]); } },
    };
    expect(await (sweep as any)._handler(ctx, {})).toEqual({ repositories: 1, pulls: 2 });
    expect(scheduled).toEqual([[0, 7], [3000, 8]]);
  });
});

test("a token minted for a machine can never post a status or a check", () => {
  expect(Object.keys(HOST_TOKEN_PERMISSIONS)).not.toContain("statuses");
  expect(Object.keys(HOST_TOKEN_PERMISSIONS)).not.toContain("checks");
});
