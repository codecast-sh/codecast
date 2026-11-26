// Codecast's `approval` status (ct-100350): the rule (decide), the status worked out from a mocked GitHub and posted,
// the approvals a person's card and press make or revoke, and the merge as codecast's app. The automatic review of a pull
// request no run is behind, and its hold, are changeApprovals.automatic.test.ts.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { decide, evaluate, evaluateLanding, mechanismOf, mergeAsApp, settle, sweep, type ApprovalFacts } from "./changeApprovals";
import { actionCtx, gh, github, HEAD, installation, LAND_PATCH, MB, prRow, REPO, useMockedGitHub } from "./changeApprovals.testkit";
import { HOST_TOKEN_PERMISSIONS } from "./githubApp";
import { approvalStampFor, changeJudgedFiles, claimPress, gateOf, noticeCaptainRevertMerged, settleCardApproval } from "./lib/changeApprovalRows";
import { processPRSynchronizeEvent } from "./githubWebhooks";
import { merge } from "./prCli";
import { answerCore, withdrawCore } from "./sessionDecisions";

const needs = { judged: "Jason", mechanism: "an engineer or Ashot", review: "Ashot" };
const facts = (over: Partial<Extract<ApprovalFacts, { judged: string[] }>> = {}): ApprovalFacts => ({ opted: true, judged: [], run: "live", mechanism: false, card: null, press: null, needs, ...over });

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

useMockedGitHub();

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

  test("reads all three pages, finds the judged file on the last, and with no codecast run asks the area's owner to review", async () => {
    github();
    const db = makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [], change_approvals: [], users: [] });
    const { ctx } = actionCtx(db);
    // No run behind it, and the automatic review has no budget to run on: it fails closed to the area's owner, here an
    // owners file id this deployment does not know, so the status names no one in particular.
    const out: any = await (evaluate as any)._handler(ctx, { repository: REPO, pr_number: 7, post: true });
    expect(gh.calls.filter((c) => /\/files\?/.test(c.url)).map((c) => /[?&]page=(\d+)/.exec(c.url)![1])).toEqual(["1", "2", "3"]);
    expect(out).toMatchObject({ state: "pending", description: "needs a review by a person: the automatic review could not answer (the team's model budget has no room for it)", posted: true, context: "approval (shadow)" });
    const post = gh.calls.find((c) => c.method === "POST" && /statuses/.test(c.url))!;
    expect(post.url).toEndWith(`/repos/${REPO}/statuses/${HEAD}`);
    expect(post.body).toEqual({ state: "pending", description: "needs a review by a person: the automatic review could not answer (the team's model budget has no room for it)", context: "approval (shadow)" });
    expect(db._tables.pull_requests[0].approval).toMatchObject({ head_sha: HEAD, state: "pending", judged_files: ["outreach/line/change/land.cast"] });
    expect(db._tables.pull_requests[0].approval.judged_key).toMatch(/^[0-9a-f]{40}$/);
    // The whole diff (all 250 files) has its own patch id.
    expect(db._tables.pull_requests[0].approval.whole_key).toMatch(/^whole:[0-9a-f]{40}$/);
    expect(db._tables.pull_requests[0].approval.whole_key).not.toBe(`whole:${db._tables.pull_requests[0].approval.judged_key}`);
  });

  test("a GitHub read error keeps the engineers the gate last read; a read file replaces them", async () => {
    const stored = [{ user_id: "ash", name: "Ashot" }, { user_id: "jas", name: "Jason" }];
    const inst = { ...installation, approval_gate: [{ ...installation.approval_gate[0], engineers: stored }] };
    gh.routes.push({ method: "GET", match: /\/contents\/outreach\/line\/change\/engineers\.txt/, reply: () => ({ status: 502, text: "bad gateway" }) });
    github();
    const db = makeFakeDb({ github_app_installations: [inst], pull_requests: [prRow], workflow_runs: [], change_approvals: [], users: [] });
    expect(await (evaluate as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, post: false })).toMatchObject({ state: "pending", description: expect.stringContaining("could not read GitHub") });
    expect(db._tables.github_app_installations[0].approval_gate[0].engineers).toEqual(stored);
    gh.routes.shift();
    await (evaluate as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, post: false });
    expect(db._tables.github_app_installations[0].approval_gate[0].engineers).toEqual([{ user_id: "ash", name: "Ashot" }]);
  });

  test("what GitHub shows decides whether to post: a stale status an overlapping evaluation landed last is posted over", async () => {
    github();
    const db = makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [], change_approvals: [], users: [] });
    const posts = () => gh.calls.filter((c) => c.method === "POST" && /statuses/.test(c.url)).length;
    const evaluateNow = async () => (evaluate as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, post: true });
    expect(await evaluateNow()).toMatchObject({ state: "pending", posted: true });
    expect(posts()).toBe(1);
    // GitHub already shows these words on the head: not posted again.
    expect((await evaluateNow()).unchanged).toBe(true);
    expect(posts()).toBe(1);
    // Two evaluations of one head overlapped and the older one's success reached GitHub last.
    gh.shown.unshift({ context: "approval (shadow)", state: "success", description: "approved by Ashot (card sd-1)" });
    const swept: any = await evaluateNow();
    expect(swept.unchanged).toBeUndefined();
    expect(posts()).toBe(2);
    expect(gh.shown[0]).toMatchObject({ state: "pending", description: "needs a review by a person: the automatic review could not answer (the team's model budget has no room for it)" });
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
    gh.routes = gh.routes.filter((r) => !/judges/.test(String(r.match)));
    gh.routes.unshift({ method: "GET", match: /judges\.txt/, reply: () => ({ status: 404 }) });
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
    expect(gh.calls.some((c) => /statuses/.test(c.url))).toBe(false);
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

  test("an agent's `cast decide cancel` on the run's card leaves its approvals standing; only a person's no revokes", async () => {
    const held = [
      { _id: "a1", repository: REPO, workflow_run_id: "run1", source: "ship_press", files: [], user_id: "u1", created_at: 1 },
      { _id: "a2", repository: REPO, workflow_run_id: "run1", source: "card", files: [], user_id: "u1", created_at: 2 },
    ];
    const pending = { ...card("Ship"), status: "pending", user_id: "u1", question: "Ship it?", kind: "single", created_at: 5 };
    const db = makeFakeDb({ github_app_installations: [installation], workflow_runs: [run], change_approvals: held, session_decisions: [pending], decision_inbox: [] });
    // The one withdraw every path takes: it settles the card as the conversation's owner, kind "user".
    await withdrawCore({ db, scheduler: { runAfter: async () => {} } } as any, pending as any, 20, "c1" as any);
    expect(db._tables.session_decisions[0].status).toBe("withdrawn");
    expect(db._tables.change_approvals.map((a: any) => a.revoked_at)).toEqual([undefined, undefined]);
    expect(db._inserted).toEqual([]);
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
    expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);

    // Approved by a card for this key: merges as the app.
    db = makeFakeDb({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [run], change_approvals: [card], users: [{ _id: "u1", name: "Ashot" }] });
    await (evaluate as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, post: false });
    // The card answered on this judged diff: the key codecast worked out for the head.
    db._tables.change_approvals[0].judged_key = db._tables.pull_requests[0].approval.judged_key;
    gh.calls = [];
    out = await (mergeAsApp as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, expected_head_sha: HEAD, commit_title: "Squash", commit_message: "why" });
    expect(out).toMatchObject({ merged: true });
    const put = gh.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ merge_method: "squash", sha: HEAD, commit_title: "Squash", commit_message: "why" });
    expect(put.auth).toBe("Bearer app_tok");

    // GitHub's status says otherwise: refused.
    gh.routes = gh.routes.filter((r) => !/statuses\//.test(String(r.match)) || r.method === "POST");
    gh.routes.push({ method: "GET", match: /\/commits\/[0-9a-f]{40}\/statuses/, reply: () => ({ json: [{ context: "approval (shadow)", state: "pending" }] }) });
    gh.calls = [];
    out = await (mergeAsApp as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, expected_head_sha: HEAD });
    expect(out.error).toMatch(/status on .* is pending/);
    expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);
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

  test("for a change Cam asked for (by codecast's record), an engineer's in-person yes before the build approves its judged files only, bound to that diff", async () => {
    const users = [{ _id: "cam", name: "Cameron Musgrave" }, { _id: "ash", name: "Ashot" }, { _id: "sam", name: "Samvit" }];
    const tasks = [{ _id: "t1", user_id: "cam" }];
    const yes = (who: string, at: number, over: Record<string, any> = {}) => ({ _id: `sd_${who}_${at}`, short_id: `sd-${who}`, task_id: "t1", status: "answered", station: "pre-build", options: [{ label: "Yes" }, { label: "No" }], answer_index: 0, answered_by: { kind: "user", id: who }, resolved_at: at, ...over });
    const engineers = [{ user_id: "ash", name: "Ashot" }];
    const asked = { ...args, people: { title: "t", area_owner: { user_id: "sam", name: "Samvit" }, engineers } };
    const later = { ...base, created_at: 100, node_statuses: [{ node_id: "review", status: "completed", session_id: "s", started_at: 102 }], review_verdict: { ...base.review_verdict, attempt: 100 }, pr: { ...base.pr } };
    const approved = ctxOf({ workflow_runs: [later], users, tasks, session_decisions: [yes("ash", 50)] });
    expect(await (settle as any)._handler(approved, asked)).toMatchObject({ state: "success", description: "approved by Ashot (sd-ash before the build)" });
    expect(approved.db._tables.change_approvals[0]).toMatchObject({ source: "engineer_yes", judged_key: "k1", user_id: "ash" });
    // A later judged diff that differs asks again; a mechanism still needs its own engineer approval.
    expect(await (settle as any)._handler(approved, { ...asked, key: "k2", head_sha: "d".repeat(40) })).toMatchObject({ state: "pending" });
    const mech = ctxOf({ workflow_runs: [{ ...later, review_verdict: { ...later.review_verdict, mechanism: true } }], users, tasks, session_decisions: [yes("ash", 50)] });
    expect(await (settle as any)._handler(mech, asked)).toMatchObject({ state: "pending", description: "needs Ashot: the review called it a mechanism" });
    // An engineer's yes to some other question on the task (not asked as the pre-build question) approves nothing.
    const otherQuestion = ctxOf({ workflow_runs: [later], users, tasks, session_decisions: [yes("ash", 50, { station: undefined })] });
    expect(await (settle as any)._handler(otherQuestion, asked)).toMatchObject({ state: "pending" });
    // Cam's own yes, one given after the build began, one given through a session, or a non-engineer's: none counts.
    const notYet = ctxOf({ workflow_runs: [later], users, tasks, session_decisions: [yes("cam", 50), yes("ash", 150), yes("ash", 40, { answered_by: { kind: "user", id: "ash", via: "c1" } }), yes("sam", 30)] });
    expect(await (settle as any)._handler(notYet, asked)).toMatchObject({ state: "pending", description: "needs Samvit: edits outreach/line/change/land.cast" });
    // Not Cam's change by codecast's record: a Cameron trailer unlocks nothing.
    const notCam = ctxOf({ workflow_runs: [later], users, tasks: [{ _id: "t1", user_id: "sam" }], session_decisions: [yes("ash", 50)] });
    expect(await (settle as any)._handler(notCam, { ...asked, requested_by: "Cameron" })).toMatchObject({ state: "pending" });
  });

  test("a card that showed no judged diff approves nothing when Shipped", async () => {
    const c = ctxOf({ workflow_runs: [base], users: [] });
    const unstamped = { _id: "sd1", workflow_run_id: "run1", options: [{ label: "Ship" }], conversation_id: "c1" };
    await settleCardApproval(c as any, unstamped as any, { status: "answered", answer_index: 0 }, { kind: "user", user_id: "u1" as any }, 10);
    expect(c.db._tables.change_approvals).toEqual([]);
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

test("the Release Captain's exemption needs every commit of the pull request to be a revert", async () => {
  const captain = { _id: "run1", user_id: "agent", created_at: 1, org_role_id: "role1", node_statuses: [], pr: { repository: REPO, number: 7, first_head_sha: HEAD, head_sha: HEAD, at: 1 } };
  const revert = { commit: { message: `Revert "x"\n\nThis reverts commit ${"c".repeat(40)}.` } };
  const outcome = async (commits: any[]) => {
    github();
    // Ahead of github()'s own commits route, so this list is the one read.
    gh.routes.unshift({ method: "GET", match: /\/pulls\/7\/commits/, reply: () => ({ json: commits }) });
    const db = makeFakeDb(structuredClone({ github_app_installations: [installation], pull_requests: [prRow], workflow_runs: [captain], org_roles: [{ _id: "role1", handle: "release", name: "Release Captain" }], change_approvals: [], users: [] }));
    return ((await (evaluate as any)._handler(actionCtx(db).ctx, { repository: REPO, pr_number: 7, post: false })) as any).state;
  };
  expect(await outcome([revert, revert])).toBe("success");
  expect(await outcome([revert, { commit: { message: "Also change the gate" } }])).toBe("pending");
});

describe("the approval card", () => {
  const reviewed = (mechanism?: boolean) => ({ node_statuses: [{ node_id: "review", status: "completed", session_id: "rev", started_at: 2 }], review_verdict: { node_id: "review", verdict: "ship", head_sha: HEAD, ...(mechanism === undefined ? {} : { mechanism }), at: 3, attempt: 1 } });
  const run = (over: Record<string, any> = {}) => ({ _id: "run1", user_id: "host", team_id: "team1", status: "running", created_at: 1, task_id: "t1", primary_conversation_id: "c_log", pr: { repository: REPO, number: 7, first_head_sha: HEAD, head_sha: HEAD, at: 1 }, ...reviewed(false), ...over });
  const users = [{ _id: "u_jason", name: "Jason Benn" }, { _id: "u_ashot", name: "Ashot" }, { _id: "u_cam", name: "Cameron" }, { _id: "host", name: "Host" }];
  const memberships = users.map((u, i) => ({ _id: `m${i}`, team_id: "team1", user_id: u._id }));
  // Each person's own session too: a card no run is behind is asked only there.
  const conversations = [{ _id: "c_log", session_id: "wf-run1", user_id: "host", title: "Change" }, { _id: "c_rev", session_id: "rev", user_id: "host", title: "Review" }, { _id: "c_anchor", session_id: "anchor", user_id: "host", title: "Agent" },
    ...["u_jason", "u_ashot", "u_cam"].map((u) => ({ _id: `c_own_${u}`, session_id: `own-${u}`, user_id: u, title: "Own", updated_at: 1, team_id: "team1" }))];
  const world = (tables: Record<string, any[]> = {}) => {
    // Every world gets its own copies: the fake db patches rows in place.
    const db = makeFakeDb(structuredClone({ github_app_installations: [installation], pull_requests: [prRow], change_approvals: [], users, team_memberships: memberships, conversations, anchors: [{ _id: "a1", team_id: "team1", conversation_id: "c_anchor" }], session_decisions: [], decision_inbox: [], task_comments: [{ _id: "tc1", task_id: "t1", comment_type: "review", text: "Verdict: ship. It edits land.cast.", created_at: 5 }], pending_messages: [], workflow_runs: [run()], ...tables }));
    return { db, ctx: { db, scheduler: { runAfter: async () => {} } } };
  };
  const people = { title: "Edit land", area_owner: { user_id: "u_ashot", name: "Ashot" }, engineers: [{ user_id: "u_jason", name: "Jason" }] };
  const args = { repository: REPO, pr_number: 7, head_sha: HEAD, judged: ["outreach/line/change/land.cast"], key: "k1", people };
  /** No run behind it, and the automatic review gave no answer for the head: a person reads it whole. */
  const noAnswer = { ...args, automatic: { head_sha: HEAD, failed: true, reason: "the team's model budget has no room for it", at: 1 } };
  const cards = (db: any) => db._tables.session_decisions.filter((d: any) => d.approval_card);

  test("judged files a press did not list go to the presser, once per judged diff, with the files and the review's words", async () => {
    const w = world({ workflow_runs: [run({ pressed_approval_id: "p1" })], change_approvals: [{ _id: "p1", repository: REPO, workflow_run_id: "run1", source: "ship_press", files: ["docs/a.md"], user_id: "u_jason", created_at: 1 }] });
    expect(await (settle as any)._handler(w.ctx, args)).toMatchObject({ state: "pending", description: "needs Jason Benn: edits outreach/line/change/land.cast" });
    expect(cards(w.db)).toEqual([expect.objectContaining({ asked_user_ids: ["u_jason"], holder: { kind: "user", id: "u_jason" }, conversation_id: "c_log", silent: true, approval: expect.objectContaining({ judged_key: "k1", reason: "judged", run_id: "run1" }) })]);
    expect(cards(w.db)[0].context_md).toContain("outreach/line/change/land.cast");
    expect(cards(w.db)[0].context_md).toContain("Verdict: ship. It edits land.cast.");
    expect(cards(w.db)[0].options[0].label).toBe("Approve merge");
    await (settle as any)._handler(w.ctx, args);
    expect(cards(w.db)).toHaveLength(1);
    // A changed judged diff is a new question.
    await (settle as any)._handler(w.ctx, { ...args, key: "k2" });
    expect(cards(w.db)).toHaveLength(2);
  });

  test("a changed judged diff withdraws the open card and asks with a new one; the old one can approve nothing", async () => {
    const w = world();
    await (settle as any)._handler(w.ctx, { ...args, requested_by: "Jason" });
    const [first] = cards(w.db);
    // The review is asked again on a new head of the same diff: the card stands.
    w.db._tables.workflow_runs[0] = { ...w.db._tables.workflow_runs[0], ...reviewed(undefined) };
    await (settle as any)._handler(w.ctx, { ...args, requested_by: "Jason", head_sha: "c".repeat(40) });
    expect(cards(w.db).map((c: any) => c.status)).toEqual(["pending"]);
    // The judged diff changed while the review is still out: the card asks about a diff the pull request no longer has.
    await (settle as any)._handler(w.ctx, { ...args, requested_by: "Jason", key: "k2", head_sha: "c".repeat(40) });
    expect(cards(w.db).map((c: any) => c.status)).toEqual(["withdrawn"]);
    expect(w.db._tables.pull_requests[0].approval.card_id).toBeUndefined();
    // The review answers: one new card, for k2, and only it is open.
    w.db._tables.workflow_runs[0] = { ...w.db._tables.workflow_runs[0], ...reviewed(false), review_verdict: { ...reviewed(false).review_verdict, head_sha: "c".repeat(40) } };
    await (settle as any)._handler(w.ctx, { ...args, requested_by: "Jason", key: "k2", head_sha: "c".repeat(40) });
    expect(cards(w.db).map((c: any) => [c.status, c.approval.judged_key])).toEqual([["withdrawn", "k1"], ["pending", "k2"]]);
    expect(w.db._tables.change_approvals).toEqual([]);
    // A withdrawn card's settle (the withdrawal itself) neither approves nor revokes.
    await settleCardApproval(w.ctx as any, first, { status: "withdrawn" }, { kind: "user", user_id: "host" as any }, 40);
    expect(w.db._tables.change_approvals).toEqual([]);
  });

  test("an approval that lands another way withdraws the open card", async () => {
    const w = world();
    await (settle as any)._handler(w.ctx, { ...args, requested_by: "Jason" });
    w.db._tables.change_approvals.push({ _id: "p9", repository: REPO, pr_number: 7, judged_key: "k1", source: "ship_press", files: args.judged, user_id: "u_jason", created_at: 50 });
    expect(await (settle as any)._handler(w.ctx, { ...args, requested_by: "Jason" })).toMatchObject({ state: "success" });
    expect(cards(w.db).map((c: any) => c.status)).toEqual(["withdrawn"]);
  });

  test("on a pull request no run is behind the author is asked nothing: owner, admins and installer count without them (second review round 2, finding 2)", async () => {
    const byId = world({ workflow_runs: [] });
    await (settle as any)._handler(byId.ctx, noAnswer);
    expect(cards(byId.db)[0].asked_user_ids).toEqual(["u_ashot"]);
    const admins = memberships.map((m) => (m.user_id === "u_ashot" || m.user_id === "u_jason" || m.user_id === "u_cam" ? { ...m, role: "admin", joined_at: m.user_id === "u_ashot" ? 0 : m.user_id === "u_jason" ? 1 : 2 } : m));
    const ashotWrote = { ...people, author_login: "ashot-gh" };
    const withLogins = users.map((u) => (u._id === "u_ashot" ? { ...u, github_username: "ashot-gh" } : u._id === "u_jason" ? { ...u, github_username: "jason-gh" } : u));
    // The owner wrote it (Union's owners file names Ashot for everything): the admins other than Ashot, all asked.
    const ownerWrote = world({ workflow_runs: [], users: withLogins, team_memberships: admins });
    expect(await (settle as any)._handler(ownerWrote.ctx, { ...noAnswer, people: ashotWrote })).toMatchObject({ description: "needs a review by Jason Benn: the automatic review could not answer (the team's model budget has no room for it)" });
    expect(cards(ownerWrote.db)[0].asked_user_ids).toEqual(["u_jason", "u_cam"]);
    // A failure with no owner, written by a member who is an admin: every reason leaves them out.
    const noOwner = world({ workflow_runs: [], users: withLogins, team_memberships: admins });
    await (settle as any)._handler(noOwner.ctx, { ...noAnswer, people: { title: "Bump", author_login: "jason-gh", engineers: [] } });
    expect(cards(noOwner.db)[0].asked_user_ids).toEqual(["u_ashot", "u_cam"]);
    // An unknown owner id, and no admin but its author: whoever installed codecast's app.
    const inst = { ...installation, installed_by_user_id: "u_cam" };
    const onlyAuthor = world({ workflow_runs: [], users: withLogins, github_app_installations: [inst], team_memberships: memberships.map((m) => (m.user_id === "u_jason" ? { ...m, role: "admin" } : m)) });
    expect(await (settle as any)._handler(onlyAuthor.ctx, { ...noAnswer, people: { ...people, author_login: "jason-gh", area_owner: { user_id: "not-an-id", name: "Samvit" } } })).toMatchObject({ description: "needs a review by Cameron: the automatic review could not answer (the team's model budget has no room for it)" });
    expect(cards(onlyAuthor.db)[0].asked_user_ids).toEqual(["u_cam"]);
  });

  test("agent work with nobody's press goes to its Requested-by person; a mechanism to an engineer presser, else the area's owner", async () => {
    const asked = world();
    await (settle as any)._handler(asked.ctx, { ...args, requested_by: "Jason" });
    expect(cards(asked.db)[0].asked_user_ids).toEqual(["u_jason"]);
    const mech = world({ workflow_runs: [run({ ...reviewed(true), pressed_approval_id: "p1" })], change_approvals: [{ _id: "p1", repository: REPO, workflow_run_id: "run1", source: "ship_press", files: [], user_id: "u_jason", created_at: 1 }] });
    expect(await (settle as any)._handler(mech.ctx, { ...args, judged: [] })).toMatchObject({ description: "needs Jason Benn: the review called it a mechanism" });
    const notEngineer = world({ workflow_runs: [run({ ...reviewed(true) })] });
    await (settle as any)._handler(notEngineer.ctx, { ...args, judged: [], people: { ...people, engineers: [] } });
    expect(cards(notEngineer.db)[0].asked_user_ids).toEqual(["u_ashot"]);
  });

  test("Cam's change: the card goes to the engineer, never to Cam", async () => {
    // Cam asked, by codecast's record: the task is his.
    const w = world({ tasks: [{ _id: "t1", user_id: "u_cam" }] });
    await (settle as any)._handler(w.ctx, { ...args, people: { ...people, area_owner: undefined } });
    expect(cards(w.db)[0].asked_user_ids).toEqual(["u_jason"]);
  });

  test("a pull request no codecast run is behind asks the area's owner in their own session, never the team agent's or the pull request's", async () => {
    const w = world({ workflow_runs: [], pull_requests: [{ ...prRow, linked_session_ids: ["c_log"] }] });
    expect(await (settle as any)._handler(w.ctx, noAnswer)).toMatchObject({ state: "pending", description: "needs a review by Ashot: the automatic review could not answer (the team's model budget has no room for it)" });
    expect(cards(w.db)[0]).toMatchObject({ asked_user_ids: ["u_ashot"], conversation_id: "c_own_u_ashot", approval: { reason: "review" } });
  });

  test("with no session of theirs in the repository's team, they are told and no card key is kept; the card is posted once they have one (round 4, findings 2 and 3)", async () => {
    const own = world({ workflow_runs: [], anchors: [], conversations: [{ _id: "c_mine", session_id: "mine", user_id: "u_ashot", title: "Mine", updated_at: 5, team_id: "team1" }] });
    await (settle as any)._handler(own.ctx, noAnswer);
    expect(cards(own.db)[0]).toMatchObject({ asked_user_ids: ["u_ashot"], conversation_id: "c_mine" });
    // Ashot's newest session is another workspace's: never used. He is told, and nothing remembers a card.
    const elsewhere = world({ workflow_runs: [], anchors: [], notifications: [], conversations: [{ _id: "c_other_team", session_id: "other", user_id: "u_ashot", title: "Elsewhere", updated_at: 9, team_id: "team2" }] });
    await (settle as any)._handler(elsewhere.ctx, noAnswer);
    expect(cards(elsewhere.db)).toEqual([]);
    expect(elsewhere.db._tables.notifications).toEqual([expect.objectContaining({ recipient_user_id: "u_ashot", type: "card_waiting" })]);
    expect(elsewhere.db._tables.pull_requests[0].approval.card_key).toBeUndefined();
    // The next evaluation tries again, telling him nothing new while the notice is unread.
    await (settle as any)._handler(elsewhere.ctx, noAnswer);
    expect(elsewhere.db._tables.notifications).toHaveLength(1);
    // He starts a session in the team: the next evaluation posts the card there.
    elsewhere.db._tables.conversations.push({ _id: "c_team_now", session_id: "now", user_id: "u_ashot", title: "Now", updated_at: 10, team_id: "team1" });
    await (settle as any)._handler(elsewhere.ctx, noAnswer);
    expect(cards(elsewhere.db)).toEqual([expect.objectContaining({ asked_user_ids: ["u_ashot"], conversation_id: "c_team_now" })]);
    expect(elsewhere.db._tables.pull_requests[0].approval.card_key).toBeDefined();
  });

  // The answer path marks the card answered, then settles it.
  const answer = async (w: ReturnType<typeof world>, card: any, at: number) => {
    w.db._tables.session_decisions.find((d: any) => d._id === card._id).status = "answered";
    return settleCardApproval(w.ctx as any, card, { status: "answered", answer_index: 0 }, { kind: "user", user_id: card.asked_user_ids[0] as any }, at);
  };

  test("a no-run card approves the head it showed: a later push, even of unjudged code, asks again", async () => {
    const w = world({ workflow_runs: [] });
    await (settle as any)._handler(w.ctx, noAnswer);
    const [card] = cards(w.db);
    expect(card.approval).toMatchObject({ judged_key: `head:${HEAD}`, reason: "review" });
    await answer(w, card, 20);
    expect(await (settle as any)._handler(w.ctx, noAnswer)).toMatchObject({ state: "success", description: `approved by Ashot (${card.short_id})` });
    // Same judged diff (key k1), new head: the judged-diff key no longer carries a no-run approval.
    const next = "c".repeat(40);
    expect(await (settle as any)._handler(w.ctx, { ...args, head_sha: next, automatic: { ...noAnswer.automatic, head_sha: next } })).toMatchObject({ state: "pending", description: "needs a review by Ashot: the automatic review could not answer (the team's model budget has no room for it)" });
    expect(cards(w.db).map((c: any) => [c.status, c.approval.judged_key])).toEqual([["answered", `head:${HEAD}`], ["pending", `head:${next}`]]);
  });

  test("a no-run pull request with no answer yet for its head waits for the automatic review and cards nobody, judged files or not", async () => {
    for (const over of [{ judged: [], key: "none" }, {}]) {
      const w = world({ workflow_runs: [] });
      expect(await (settle as any)._handler(w.ctx, { ...args, ...over })).toEqual({ state: "pending", description: "waiting for codecast's automatic review", context: "approval (shadow)" });
      expect(cards(w.db)).toEqual([]);
    }
  });

  test("an answered card on a pull request codecast could not read approves that head", async () => {
    const w = world();
    const unreadable = { repository: REPO, pr_number: 7, head_sha: HEAD, unreadable: "main's judges.txt", people };
    expect(await (settle as any)._handler(w.ctx, unreadable)).toMatchObject({ state: "pending", description: "could not read main's judges.txt; a person approves" });
    const [card] = cards(w.db);
    expect(card.approval).toMatchObject({ judged_key: `head:${HEAD}`, reason: "unreadable" });
    await answer(w, card, 20);
    expect(await (settle as any)._handler(w.ctx, unreadable)).toMatchObject({ state: "success", description: `approved by Ashot (${card.short_id})` });
    expect(await (settle as any)._handler(w.ctx, { ...unreadable, head_sha: "c".repeat(40) })).toMatchObject({ state: "pending" });
  });

  test("a run that ended with no mechanism answer cards whoever reads a mechanism, and asks its reviewer nothing", async () => {
    const w = world({ workflow_runs: [run({ ...reviewed(undefined), status: "completed" })] });
    expect(await (settle as any)._handler(w.ctx, args)).toMatchObject({ state: "pending", description: "needs a review by Ashot: the review gave no mechanism answer" });
    expect(w.db._tables.pending_messages).toEqual([]);
    const [card] = cards(w.db);
    expect(card).toMatchObject({ asked_user_ids: ["u_ashot"], approval: { judged_key: `head:${HEAD}`, reason: "review", run_id: "run1" } });
    await answer(w, card, 20);
    expect(await (settle as any)._handler(w.ctx, args)).toMatchObject({ state: "success" });
  });

  // The review read the head given (a new run's review, or the same review after a rebase of its own).
  const reviewedAt = (w: ReturnType<typeof world>, head: string, mechanism: boolean) => {
    const r = w.db._tables.workflow_runs[0];
    r.review_verdict = { ...reviewed(mechanism).review_verdict, head_sha: head };
  };

  test("a mechanism card approves the whole diff: a rebase that leaves it unchanged carries, an unjudged code change asks again", async () => {
    const w = world({ workflow_runs: [run(reviewed(true))] });
    const mech = { ...args, judged: [], key: "none", whole_key: "w1", people: { ...people, engineers: [] } };
    expect(await (settle as any)._handler(w.ctx, mech)).toMatchObject({ state: "pending", description: "needs Ashot: the review called it a mechanism" });
    const [card] = cards(w.db);
    // Keyed to the whole diff, never to the judged diff's constant "none".
    expect(card.approval).toMatchObject({ judged_key: "whole:w1", reason: "mechanism" });
    await answer(w, card, 20);
    expect(await (settle as any)._handler(w.ctx, mech)).toMatchObject({ state: "success", description: `approved by Ashot (${card.short_id})` });
    // A rebase: new head, the same whole diff.
    const rebased = "c".repeat(40);
    reviewedAt(w, rebased, true);
    expect(await (settle as any)._handler(w.ctx, { ...mech, head_sha: rebased })).toMatchObject({ state: "success" });
    // A push that changes an unjudged file: the judged diff is still "none", the whole diff is not.
    const pushed = "d".repeat(40);
    reviewedAt(w, pushed, true);
    expect(await (settle as any)._handler(w.ctx, { ...mech, head_sha: pushed, whole_key: "w2" })).toMatchObject({ state: "pending", description: "needs Ashot: the review called it a mechanism" });
    expect(cards(w.db).map((c: any) => [c.status, c.approval.judged_key])).toEqual([["answered", "whole:w1"], ["pending", "whole:w2"]]);
  });

  test("a card about the judged files covers them only: a mechanism a later push adds asks again", async () => {
    const w = world();
    await (settle as any)._handler(w.ctx, { ...args, whole_key: "w1", requested_by: "Jason" });
    const [card] = cards(w.db);
    expect(card.approval).toMatchObject({ judged_key: "k1", reason: "judged" });
    await answer(w, card, 20);
    expect(await (settle as any)._handler(w.ctx, { ...args, whole_key: "w1", requested_by: "Jason" })).toMatchObject({ state: "success", description: `approved by Jason Benn (${card.short_id})` });
    // Same judged diff, and the new code in unjudged files is a mechanism.
    const pushed = "d".repeat(40);
    reviewedAt(w, pushed, true);
    expect(await (settle as any)._handler(w.ctx, { ...args, head_sha: pushed, whole_key: "w2", requested_by: "Jason" })).toMatchObject({ state: "pending", description: "needs Ashot: the review called it a mechanism" });
  });

  test("every changed file judged: the two patch ids are equal, and a judged-files card's yes still does not cover a mechanism", async () => {
    const w = world();
    const allJudged = { ...args, whole_key: "k1", requested_by: "Jason" };
    await (settle as any)._handler(w.ctx, allJudged);
    const [card] = cards(w.db);
    expect(card.approval).toMatchObject({ judged_key: "k1", reason: "judged" });
    await answer(w, card, 20);
    expect(await (settle as any)._handler(w.ctx, allJudged)).toMatchObject({ state: "success" });
    // The review now calls the same diff a mechanism: the engineer who reads one is carded.
    reviewedAt(w, HEAD, true);
    expect(await (settle as any)._handler(w.ctx, allJudged)).toMatchObject({ state: "pending", description: "needs Ashot: the review called it a mechanism" });
    expect(cards(w.db).at(-1)).toMatchObject({ status: "pending", asked_user_ids: ["u_ashot"], approval: { judged_key: "whole:k1", reason: "mechanism" } });
  });

  test("a Ship on the run's own card approves its judged diff and the whole diff it showed, so it covers a mechanism until code changes", async () => {
    const gateCard = { _id: "sd_gate", short_id: "sd-7", workflow_run_id: "run1", options: [{ label: "Ship" }, { label: "Revise" }], conversation_id: "c_log", task_id: "t1", approval: { repository: REPO, pr_number: 7, judged_key: "k1", whole_key: "whole:w1", files: args.judged } };
    const w = world({ workflow_runs: [run(reviewed(true))], session_decisions: [{ ...gateCard, status: "answered" }] });
    await settleCardApproval(w.ctx as any, gateCard as any, { status: "answered", answer_index: 0 }, { kind: "user", user_id: "u_jason" as any }, 20);
    expect(w.db._tables.change_approvals.map((a: any) => a.judged_key)).toEqual(["k1", "whole:w1"]);
    expect(await (settle as any)._handler(w.ctx, { ...args, whole_key: "w1" })).toMatchObject({ state: "success", description: "approved by Jason Benn (sd-7)" });
    const pushed = "d".repeat(40);
    reviewedAt(w, pushed, true);
    expect(await (settle as any)._handler(w.ctx, { ...args, head_sha: pushed, whole_key: "w2" })).toMatchObject({ state: "pending", description: "needs Ashot: the review called it a mechanism" });
  });

  test("a review that gave no mechanism answer is asked again in its own session, once per head, and nobody is carded", async () => {
    const w = world({ workflow_runs: [run(reviewed(undefined))] });
    expect(await (settle as any)._handler(w.ctx, args)).toMatchObject({ description: "waiting for the review's mechanism answer" });
    await (settle as any)._handler(w.ctx, args);
    expect(cards(w.db)).toEqual([]);
    const asks = w.db._tables.pending_messages.filter((m: any) => m.conversation_id === "c_rev");
    expect(asks).toHaveLength(1);
    expect(asks[0].content).toContain("--mechanism true");
  });

  test("Approve merge on the card approves that judged diff and re-posts; Revise revokes the run's approvals", async () => {
    const w = world({ workflow_runs: [run({ pressed_approval_id: "p1" })], change_approvals: [{ _id: "p1", repository: REPO, workflow_run_id: "run1", source: "ship_press", files: [], user_id: "u_jason", created_at: 1 }] });
    await (settle as any)._handler(w.ctx, args);
    const card = cards(w.db)[0];
    await settleCardApproval(w.ctx as any, card, { status: "answered", answer_index: 0 }, { kind: "user", user_id: "u_jason" as any }, 20);
    expect(w.db._tables.change_approvals.at(-1)).toMatchObject({ source: "card", judged_key: "k1", pr_number: 7, decision_id: card._id, user_id: "u_jason" });
    expect(await (settle as any)._handler(w.ctx, args)).toMatchObject({ state: "success" });
    await settleCardApproval(w.ctx as any, card, { status: "answered", answer_index: 1 }, { kind: "user", user_id: "u_jason" as any }, 30);
    expect(w.db._tables.change_approvals.every((a: any) => a.revoked_at === 30)).toBe(true);
  });

  test("a merged Release Captain revert that touched a judged file tells the first engineer once", async () => {
    const inst = { ...installation, approval_gate: [{ ...installation.approval_gate[0], engineers: [{ user_id: "u_jason", name: "Jason" }] }] };
    const pr = { ...prRow, state: "merged", approval: { head_sha: HEAD, state: "success", description: "x", captain_revert: true, judged_files: ["outreach/line/change/land.cast"] } };
    const w = world({ github_app_installations: [inst], pull_requests: [pr], notifications: [] });
    expect(await noticeCaptainRevertMerged(w.ctx as any, w.db._tables.pull_requests[0])).toBe(true);
    expect(await noticeCaptainRevertMerged(w.ctx as any, w.db._tables.pull_requests[0])).toBe(false);
  });
});

test("an api-token answer to a --run card is refused, Don't run included, as on main: the asking agent holds that token too", async () => {
  const card = { _id: "sd_run", short_id: "sd-501", status: "pending", conversation_id: "c_me", user_id: "u_me", asked_user_ids: ["u_me"], question: "Grant ads spend?", kind: "single", options: [{ label: "Approve" }, { label: "Decline" }], run: { argv: ["role", "authority"], state: "waiting", device_id: "dev", cwd: "/repo" }, created_at: 1 };
  const db = makeFakeDb(structuredClone({ session_decisions: [card], conversations: [{ _id: "c_me", session_id: "me", user_id: "u_me" }], users: [{ _id: "u_me", name: "Me" }], decision_inbox: [] }));
  const out = await answerCore({ db, scheduler: { runAfter: async () => {} } } as any, { userId: "u_me" as any }, { decision_id: "sd-501", answer_index: 1 });
  expect(out).toEqual({ error: expect.stringContaining("runs a command in your name") });
  expect(db._tables.session_decisions[0].status).toBe("pending");
});

test("Ship's list: the pull request's judged diff and the checkout's uncommitted judged files, each by the sessions that wrote it", async () => {
  const inst = { ...installation, approval_gate: [{ ...installation.approval_gate[0], judges: ["outreach/line/change/", "outreach/deploy.sh"] }] };
  const pr = (id: string, over: Record<string, any>) => ({ ...prRow, _id: id, linked_session_ids: ["c_me", "c_other"], approval: { head_sha: HEAD, state: "pending", description: "x", judged_key: "k", judged_files: ["outreach/line/change/land.cast"] }, ...over });
  const db = makeFakeDb({
    github_app_installations: [inst],
    // An open pull request at the head its judged diff was worked out for; a closed one and a stale one list nothing.
    pull_requests: [
      pr("pr1", {}),
      pr("pr2", { number: 8, state: "closed", approval: { head_sha: HEAD, state: "pending", description: "x", judged_files: ["outreach/line/change/closed.cast"] } }),
      pr("pr3", { number: 9, head_sha: "e".repeat(40), approval: { head_sha: HEAD, state: "pending", description: "x", judged_files: ["outreach/line/change/stale.cast"] } }),
    ],
    pull_request_sessions: ["pr1", "pr2", "pr3"].map((p, i) => ({ _id: `l${i}`, pull_request_id: p, conversation_id: "c_me" })),
    conversations: [{ _id: "c_me", git_root: "/repo" }, { _id: "c_other", git_root: "/wt" }],
    // The other linked session edited it in its own checkout; this session only recorded it in a commit.
    file_changes: [
      { _id: "f1", conversation_id: "c_other", file_path: "/wt/outreach/line/change/land.cast", change_type: "edit", timestamp: 1 },
      { _id: "f2", conversation_id: "c_me", file_path: "/repo/outreach/line/change/land.cast", change_type: "commit", timestamp: 2 },
    ],
    checkouts: [
      { _id: "k1", workspace: "team:team1", repository: REPO, path: "/repo/", report: { uncommitted: { sessions: [{ conversation_id: "c_third", paths: ["outreach/line/change/gate.sh", "docs/x.md"] }], unattributed: ["outreach/deploy.sh"] } } },
      { _id: "k2", workspace: "team:team1", repository: REPO, path: "/elsewhere", report: { uncommitted: { sessions: [{ conversation_id: "c_far", paths: ["outreach/line/change/far.cast"] }], unattributed: [] } } },
    ],
  });
  const gate = (await gateOf({ db }, REPO))!;
  expect(await changeJudgedFiles({ db }, { _id: "c_me" as any, git_root: "/repo" }, gate)).toEqual([
    { path: "outreach/deploy.sh", writers: [] },
    { path: "outreach/line/change/gate.sh", writers: ["c_third"] },
    { path: "outreach/line/change/land.cast", writers: ["c_other"] },
  ]);
});

describe("a landing commit, with no pull request", () => {
  const SQUASH = "5".repeat(40);
  const CARRIED = "6".repeat(40);
  const JUDGED = "outreach/line/change/land.cast";
  const reviewed = (mechanism: boolean, head = SQUASH) => ({ node_statuses: [{ node_id: "review", status: "completed", session_id: "rev", started_at: 2 }], review_verdict: { node_id: "review", verdict: "ship", head_sha: head, mechanism, at: 3, attempt: 1 } });
  const landingRun = (over: Record<string, any> = {}) => ({
    _id: "run1", user_id: "host", team_id: "team1", status: "running", created_at: 1, task_id: "t1", primary_conversation_id: "c_log",
    landing: { repository: REPO, first_sha: SQUASH, sha: SQUASH, at: 1 }, ...reviewed(false), ...over,
  });
  const users = [{ _id: "u_jason", name: "Jason Benn" }, { _id: "u_ashot", name: "Ashot" }, { _id: "host", name: "Host" }];
  const world = (tables: Record<string, any[]> = {}) => {
    const scheduled: Array<{ name: string; args: any }> = [];
    const db = makeFakeDb(structuredClone({
      github_app_installations: [installation], pull_requests: [], change_approvals: [], users, team_memberships: users.map((u, i) => ({ _id: `m${i}`, team_id: "team1", user_id: u._id })),
      conversations: [{ _id: "c_log", session_id: "wf-run1", user_id: "host", title: "Change" }], anchors: [], session_decisions: [], decision_inbox: [], task_comments: [], pending_messages: [], counters: [],
      tasks: [{ _id: "t1", title: "Edit land", user_id: "host" }], workflow_runs: [landingRun()], ...tables,
    }));
    const ctx = { db, scheduler: { runAfter: async (_ms: number, ref: any, args: any) => { scheduled.push({ name: getFunctionName(ref), args }); } } };
    return { db, ctx, scheduled, run: () => db._tables.workflow_runs[0] };
  };
  const people = { title: "Edit land", area_owner: { user_id: "u_ashot", name: "Ashot" }, engineers: [{ user_id: "u_jason", name: "Jason" }] };
  const args = { repository: REPO, run_id: "run1", head_sha: SQUASH, judged: [JUDGED], key: "k1", whole_key: "w1", people };
  const cards = (db: any) => db._tables.session_decisions.filter((d: any) => d.approval_card);

  /** GitHub as a landing reads it: the repository's default branch and main's comparison with the commit. */
  function landingGitHub(sha: string, over: Record<string, any> = {}) {
    github();
    const files = [{ filename: JUDGED, status: "modified", patch: LAND_PATCH, additions: 1, deletions: 1 }];
    gh.routes.unshift(
      { method: "GET", match: new RegExp(`/repos/${REPO}$`), reply: () => ({ json: { default_branch: "main" } }) },
      { method: "GET", match: new RegExp(`/compare/main\\.\\.\\.${sha}$`), reply: () => ({ json: { ahead_by: 1, merge_base_commit: { sha: MB }, files, commits: [{ commit: { message: "Edit land\n\nRequested-by: Samvit" }, author: { login: "x" } }], ...over } }) },
    );
  }

  test("the status is worked out from main's comparison with the commit and posted on it, and stored on the run's landing", async () => {
    landingGitHub(SQUASH);
    const w = world();
    const { ctx } = actionCtx(w.db);
    const out: any = await (evaluateLanding as any)._handler(ctx, { repository: REPO, run_id: "run1", sha: SQUASH });
    expect(out).toMatchObject({ state: "pending", description: `needs Samvit: edits ${JUDGED}`, posted: true, context: "approval (shadow)", head_sha: SQUASH });
    const post = gh.calls.find((c) => c.method === "POST" && /statuses/.test(c.url))!;
    expect(post.url).toEndWith(`/repos/${REPO}/statuses/${SQUASH}`);
    // Nothing on the landing path reads a pull request.
    expect(gh.calls.some((c) => /\/pulls/.test(c.url))).toBe(false);
    expect(w.run().landing.approval).toMatchObject({ head_sha: SQUASH, state: "pending", judged_files: [JUDGED], run_id: "run1" });
    expect(w.run().landing.approval.whole_key).toMatch(/^whole:[0-9a-f]{40}$/);
  });

  test("nothing is posted for a commit GitHub does not have yet, one main already holds, or a run that can no longer land it", async () => {
    const posts = () => gh.calls.filter((c) => c.method === "POST" && /statuses/.test(c.url)).length;
    landingGitHub(SQUASH);
    gh.routes.unshift({ method: "GET", match: new RegExp(`/compare/main\\.\\.\\.${SQUASH}$`), reply: () => ({ status: 404 }) });
    expect(await (evaluateLanding as any)._handler(actionCtx(world().db).ctx, { repository: REPO, run_id: "run1" })).toEqual({ opted: true, open: false });
    gh.routes.shift();
    gh.routes.unshift({ method: "GET", match: new RegExp(`/compare/main\\.\\.\\.${SQUASH}$`), reply: () => ({ json: { ahead_by: 0, status: "identical", files: [], commits: [] } }) });
    expect(await (evaluateLanding as any)._handler(actionCtx(world().db).ctx, { repository: REPO, run_id: "run1" })).toEqual({ opted: true, open: false });
    for (const over of [{ status: "completed" }, { status: "failed" }, { merge: { sha: SQUASH, branch: "b", into: "main", at: 2 } }]) {
      expect(await (evaluateLanding as any)._handler(actionCtx(world({ workflow_runs: [landingRun(over)] }).db).ctx, { repository: REPO, run_id: "run1" })).toEqual({ opted: true, open: false });
    }
    expect(posts()).toBe(0);
  });

  test("a Ship press ties to the first landing commit's judged diff, and still does on the commit carried onto a newer main", async () => {
    const press = { _id: "p1", repository: REPO, workflow_run_id: "run1", source: "ship_press", files: [JUDGED], user_id: "u_jason", created_at: 1 };
    const carried = landingRun({ pressed_approval_id: "p1", landing: { repository: REPO, first_sha: SQUASH, sha: CARRIED, at: 2 }, station_rebases: [{ from: SQUASH, to: CARRIED, at: 2, attempt: 1 }] });
    const w = world({ workflow_runs: [carried], change_approvals: [press] });
    expect(await (settle as any)._handler(w.ctx, { ...args, head_sha: CARRIED })).toMatchObject({ state: "success", description: "approved by Jason Benn (Ship press)" });
    const tied = w.db._tables.change_approvals[0];
    expect(tied).toMatchObject({ judged_key: "k1", head_sha: CARRIED });
    expect(tied.pr_number).toBeUndefined();
    expect(w.run().landing.approval).toMatchObject({ head_sha: CARRIED, state: "success", judged_key: "k1", whole_key: "whole:w1" });
    // An unrelated commit (no recorded rebase from the first) ties nothing.
    const unrelated = world({ workflow_runs: [{ ...carried, station_rebases: [] }], change_approvals: [press] });
    expect(await (settle as any)._handler(unrelated.ctx, { ...args, head_sha: CARRIED })).toMatchObject({ state: "pending" });
    expect(unrelated.db._tables.change_approvals[0].judged_key).toBeUndefined();
  });

  test("a mechanism asks a person on a card about the landing; their Approve merge is the run's, keyed by its diff, and nobody else's run counts", async () => {
    const w = world({ workflow_runs: [landingRun(reviewed(true))], change_approvals: [
      // Another run's approval of the very same whole diff approves nothing here.
      { _id: "other", repository: REPO, workflow_run_id: "run2", judged_key: "whole:w1", source: "card", files: [JUDGED], user_id: "u_ashot", created_at: 1 },
    ] });
    expect(await (settle as any)._handler(w.ctx, args)).toMatchObject({ state: "pending", description: "needs Ashot: the review called it a mechanism" });
    const [card] = cards(w.db);
    expect(card.question).toBe(`Approve landing ${REPO}@${SQUASH.slice(0, 10)}: Edit land?`);
    expect(card.approval).toMatchObject({ repository: REPO, sha: SQUASH, run_id: "run1", judged_key: "whole:w1", reason: "mechanism", asked: ["u_ashot"] });
    expect(card.approval.pr_number).toBeUndefined();
    expect(card.context_md).toContain(`https://github.com/${REPO}/commit/${SQUASH}`);
    expect(w.run().landing.approval).toMatchObject({ card_id: card._id, card_key: "whole:w1:mechanism" });
    await settleCardApproval(w.ctx as any, card, { status: "answered", answer_index: 0 }, { kind: "user", user_id: "u_ashot" as any }, 50);
    const approval = w.db._tables.change_approvals.find((a: any) => a.decision_id === card._id);
    expect(approval).toMatchObject({ workflow_run_id: "run1", judged_key: "whole:w1", head_sha: SQUASH, source: "card" });
    expect(approval.pr_number).toBeUndefined();
    expect(w.scheduled).toContainEqual({ name: "changeApprovals:evaluateLanding", args: { repository: REPO, run_id: "run1", sha: SQUASH, post: true } });
    expect(await (settle as any)._handler(w.ctx, args)).toMatchObject({ state: "success", description: `approved by Ashot (${card.short_id})` });
  });

  test("the run's own card stamps the landing it shows, and its Ship approves both keys for that run", async () => {
    const w = world();
    await (settle as any)._handler(w.ctx, args);
    const stamp: any = await approvalStampFor(w.ctx as any, "run1" as any);
    expect(stamp).toEqual({ approval: { repository: REPO, run_id: "run1", sha: SQUASH, judged_key: "k1", whole_key: "whole:w1", files: [JUDGED] } });
    const own = { _id: "sd_own", workflow_run_id: "run1", options: [{ label: "Ship" }, { label: "Revise" }], conversation_id: "c_log", ...stamp };
    await settleCardApproval(w.ctx as any, own as any, { status: "answered", answer_index: 0 }, { kind: "user", user_id: "host" as any }, 60);
    expect(w.db._tables.change_approvals.map((a: any) => [a.judged_key, a.workflow_run_id, a.head_sha, a.pr_number])).toEqual([["k1", "run1", SQUASH, undefined], ["whole:w1", "run1", SQUASH, undefined]]);
    // A carry moves the landing on: the stamp follows only once the new commit's status is worked out.
    w.run().landing = { ...w.run().landing, sha: CARRIED };
    expect(await approvalStampFor(w.ctx as any, "run1" as any)).toEqual({});
  });

  test("a settle for a commit the run has since replaced changes nothing and says so", async () => {
    const w = world({ workflow_runs: [landingRun({ landing: { repository: REPO, first_sha: SQUASH, sha: CARRIED, at: 2 } })] });
    expect(await (settle as any)._handler(w.ctx, args)).toEqual({ state: "pending", description: `replaced by ${CARRIED.slice(0, 10)}`, context: "approval (shadow)" });
    expect(w.run().landing.approval).toBeUndefined();
    await expect((settle as any)._handler(w.ctx, { ...args, pr_number: 7 })).rejects.toThrow("one of them");
  });
});
