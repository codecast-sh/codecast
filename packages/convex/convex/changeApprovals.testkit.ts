// The world changeApprovals.test.ts and changeApprovals.automatic.test.ts share: a mocked GitHub (every fetch answered by
// `gh.routes`, every request kept in `gh.calls`), the opted-in installation, its pull request row, and an action ctx whose
// internal calls run the real handlers over one fake db.
import { afterEach, beforeEach } from "bun:test";
import { getFunctionName } from "convex/server";

export const REPO = "union-ai/union-mobile";
export const HEAD = "a".repeat(40);
export const MB = "b".repeat(40);

type Route = { method: string; match: RegExp; reply: (url: string, body: any) => { status?: number; json?: any; text?: string } };
/** The mocked GitHub's state: its routes, the requests it saw, the statuses it shows on the head (newest first), and the head's diff. */
export const gh = {
  routes: [] as Route[],
  calls: [] as Array<{ method: string; url: string; body: any; auth?: string }>,
  shown: [] as Array<{ context: string; state: string; description: string }>,
  diff: "",
};

/** Call at a test file's top level: each test starts with GitHub mocked and the pull request row as written. */
export function useMockedGitHub() {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    gh.routes = [];
    gh.calls = [];
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      gh.calls.push({ method, url, body, auth: init.headers?.Authorization ?? init.headers?.authorization });
      const route = gh.routes.find((r) => r.method === method && r.match.test(url));
      if (!route) return new Response(`no route for ${method} ${url}`, { status: 599 });
      const r = route.reply(url, body);
      return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
    }) as any;
    // The fake db patches the rows it is given in place, and many tests hand it prRow itself: each test starts from it as written.
    for (const k of Object.keys(prRow)) delete (prRow as any)[k];
    Object.assign(prRow, structuredClone(PR_ROW));
  });
  afterEach(() => { globalThis.fetch = realFetch; });
}

export const LAND_PATCH = "@@ -1,2 +1,2 @@\n a\n-b\n+c";
/** The head's diff as GitHub renders it: one `diff --git` section a file. */
export const diffOf = (files: Array<{ filename: string; patch: string }>) => files.map((f) => `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`).join("");
/** What the repository's mechanism file says (main's outreach/line/change/mechanism.md). */
export const MECHANISM_TEXT = "A change is a mechanism when its mistake reaches many people at once and cannot be undone: REPO_DEFINITION_MARK.";
/** A pull request of 250 files: the judged one is on GitHub's third page. */
export function github(opts: { judges?: string } = {}) {
  gh.shown = [];
  const files = [
    ...Array.from({ length: 249 }, (_, i) => ({ filename: `docs/f${i}.md`, status: "modified", patch: "@@ -1 +1 @@\n-x\n+y", additions: 1, deletions: 1 })),
    { filename: "outreach/line/change/land.cast", status: "modified", patch: LAND_PATCH, additions: 1, deletions: 1 },
  ];
  gh.diff = diffOf(files);
  gh.routes.push(
    { method: "GET", match: /\/pulls\/7$/, reply: () => ({ json: { changed_files: files.length, state: "open", head: { sha: HEAD, ref: "feature" }, base: { ref: "main", repo: { default_branch: "main" } } } }) },
    { method: "GET", match: /\/pulls\/7\/files\?/, reply: (url) => { const page = Number(/[?&]page=(\d+)/.exec(url)![1]); return { json: files.slice((page - 1) * 100, page * 100) }; } },
    { method: "GET", match: /\/contents\/outreach\/line\/change\/judges\.txt\?ref=main/, reply: () => ({ text: opts.judges ?? "# judged\noutreach/line/change/\n" }) },
    { method: "GET", match: /\/contents\/outreach\/line\/change\/owners\.txt/, reply: () => ({ text: "outreach/line/ ash Ashot\n" }) },
    { method: "GET", match: /\/contents\/outreach\/line\/change\/engineers\.txt/, reply: () => ({ text: "# id name\nash Ashot\n" }) },
    { method: "GET", match: /\/compare\/main\.\.\./, reply: () => ({ json: { merge_base_commit: { sha: MB } } }) },
    { method: "GET", match: new RegExp(`/compare/${MB}\\.\\.\\.`), reply: () => ({ text: gh.diff }) },
    { method: "GET", match: /\/contents\/outreach\/line\/change\/mechanism\.md/, reply: () => ({ text: MECHANISM_TEXT }) },
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
    { method: "POST", match: /\/statuses\//, reply: (_u, body) => { gh.shown.unshift(body); return { status: 201, json: {} }; } },
    { method: "GET", match: /\/commits\/[0-9a-f]{40}\/statuses/, reply: () => ({ json: gh.shown }) },
    { method: "PUT", match: /\/pulls\/7\/merge$/, reply: () => ({ json: { merged: true, sha: "f".repeat(40) } }) },
  );
}

export const installation = { _id: "inst1", installation_id: 42, account_login: "union-ai", repository_selection: "all", team_id: "team1", approval_gate: [{ repository: REPO, judges_path: "outreach/line/change/judges.txt", mode: "shadow" }] };

/** An action ctx whose internal calls run the real handlers over one fake db. */
export function actionCtx(db: any) {
  const scheduled: Array<{ name: string; args: any }> = [];
  const mutCtx = { db, scheduler: { runAfter: async (_ms: number, ref: any, args: any) => { scheduled.push({ name: getFunctionName(ref), args }); } } };
  const ctx: any = {
    scheduler: mutCtx.scheduler,
    runQuery: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "changeApprovals:gateFor") return (await import("./lib/changeApprovalRows")).gateOf({ db }, args.repository);
      if (name === "changeApprovals:openNumbers") return [];
      if (name === "changeApprovals:landingOf") return ((await import("./changeApprovals")).landingOf as any)._handler({ db }, args);
      if (name === "vendorCoverage:refusalFor") return ((await import("./vendorCoverage")).refusalFor as any)._handler({ db }, args);
      throw new Error(`unexpected query ${name}`);
    },
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      const mod: any = await import("./changeApprovals");
      if (name === "changeApprovals:settle") return mod.settle._handler(mutCtx, args);
      if (name === "changeApprovals:noteUnposted") return mod.noteUnposted._handler(mutCtx, args);
      if (name === "changeApprovals:claimAutomaticReview") return mod.claimAutomaticReview._handler(mutCtx, args);
      if (name.startsWith("modelCalls:")) return (await import("./modelCalls") as any)[name.slice("modelCalls:".length)]._handler(mutCtx, args);
      throw new Error(`unexpected mutation ${name}`);
    },
    runAction: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "githubApp:getInstallationToken") return { token: "app_tok", expires_at: 0, permissions: { statuses: "write", contents: "write" } };
      if (name === "githubApi:mergePullRequest") return ((await import("./githubApi")).mergePullRequest as any)._handler({} as any, args);
      throw new Error(`unexpected action ${name}`);
    },
  };
  return { ctx, scheduled };
}

export const prRow = { _id: "pr1", team_id: "team1", repository: REPO, number: 7, state: "open", head_sha: HEAD, title: "t", body: "", github_pr_id: 99, author_github_username: "x", linked_session_ids: [], created_at: 1, updated_at: 1 };
const PR_ROW = structuredClone(prRow);
