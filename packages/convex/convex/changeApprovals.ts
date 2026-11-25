// Codecast's `approval` status on a pull request (ct-100350; the plan's "When a person is asked", sd-4635, sd-4636).
//
// A change to an opted-in repository that edits a judged path (main's judges file) or that its review calls a
// mechanism needs a person's approval before it merges. Codecast holds that rule, not the branch: it works the
// status out from GitHub and its own records on every push, card answer and Ship press, posts it from its app, and
// merges as its app only when the rule holds (mergeAsApp, `cast pr merge --as-app`).
//
//   approval   a person's click on Ship in codecast that listed the judged files beside the button, tied to the
//              judged diff of the first head the run's PR station pushed; or a person's Ship (or Approve merge) on
//              the run's card. An agent, a role or a policy never approves. Never the run's starter as such: agents
//              start runs as the human.
//   carry      an approval holds while the judged diff's patch id (lib/judgedDiff.ts) is unchanged: a rebase keeps
//              it, a changed judged diff asks again.
//   mechanism  the reviewer's answer counts only from a reviewer station codecast saw finish, on the head (or a head
//              the run's own rebase made of it). Until one exists the status is pending: there is no default.
//   revert     a Release Captain's revert (the run's role, and git's revert line on its commits) merges on CI's
//              required checks alone; no revert is recognised from its diff.
//   who        the status names the person a card goes to: a judged file the press did not list, the person who
//              pressed; other work, its Requested-by person, else the session's owner, else the area's owner from the
//              owners file beside the judges file (`path-prefix  person`); a mechanism, an engineer or that owner.
//
// Nothing posts for a repository until an admin opts it in (setGate), "shadow" first, under its own context.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { normalizeRepository, repositoryKeyOfRemote } from "@codecast/shared/contracts";
import { canAccessConversation } from "./lib/access";
import { requireInstallationRevoker } from "./githubApp";
import { fetchPRFiles, PR_FILES_CAP, type PRPath } from "./githubApi";
import { patchPullRequest } from "./prShepherd";
import { coveredHeads, runAttempt } from "./orgLineMerge";
import { approvalContext, gateOf, isCamRequest, isReleaseCaptain, preBuildYes } from "./lib/changeApprovalRows";
import { diffKey, isJudged, judgedPaths, keyChanged, keyEntriesFor, ownerOf, parseJudges, parseOwners, pathDiffsOf, pathsOf, requestedBy, revertedShas, type GitHubFile } from "./lib/judgedDiff";

const GITHUB = "https://api.github.com";
/** GitHub cuts a status description at 140 characters. */
const DESCRIPTION_MAX = 140;

// ── The rule ──

export type ApprovalFacts =
  | { opted: false }
  | { opted: true; unreadable: string }
  | {
      opted: true;
      judged: string[];
      /** A revert the Release Captain's run made: CI's required checks alone decide it. */
      captain_revert?: boolean;
      /** The review's answer: true a mechanism, false not, null not said (or not yet seen finished). */
      mechanism: boolean | null;
      /** A person's Ship on the run's card, for this judged diff. */
      card?: { who: string; ref: string } | null;
      /** A person's Ship press, for this judged diff. */
      press?: { who: string } | null;
      /** Who a card about the judged files goes to, and who one about a mechanism goes to, in words. */
      needs: { judged: string; mechanism: string };
    };

export type ApprovalVerdict = { state: "success" | "pending"; description: string };

const fit = (s: string) => (s.length <= DESCRIPTION_MAX ? s : `${s.slice(0, DESCRIPTION_MAX - 1)}…`);

/** "a, b (+3)": as many judged paths as fit in a status line. */
function pathList(paths: string[], room: number): string {
  const shown: string[] = [];
  for (const p of paths) {
    const more = paths.length - shown.length - 1;
    const next = [...shown, p].join(", ") + (more > 0 ? ` (+${more})` : "");
    if (next.length > room && shown.length) break;
    shown.push(p);
  }
  const rest = paths.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` (+${rest})` : "");
}

/**
 * The status, from what was read. Nothing is success before the review's mechanism answer exists, a revert aside. A
 * person's card answer covers the change whole; a Ship press covers the judged files it listed, never a mechanism.
 */
export function decide(f: ApprovalFacts): ApprovalVerdict | null {
  if (!f.opted) return null;
  if ("unreadable" in f) return { state: "pending", description: fit(`could not read ${f.unreadable}; a person approves`) };
  if (f.captain_revert) return { state: "success", description: "the Release Captain's revert: CI's required checks decide" };
  if (f.mechanism === null) return { state: "pending", description: "waiting for the review's mechanism answer" };
  if (!f.judged.length && !f.mechanism) return { state: "success", description: "no judged paths; the review: not a mechanism" };
  if (f.card) return { state: "success", description: fit(`approved by ${f.card.who} (${f.card.ref})`) };
  if (f.mechanism) return { state: "pending", description: fit(`needs ${f.needs.mechanism}: the review called it a mechanism`) };
  if (f.press) return { state: "success", description: fit(`approved by ${f.press.who} (Ship press)`) };
  const head = `needs ${f.needs.judged}: edits `;
  return { state: "pending", description: fit(head + pathList(f.judged, DESCRIPTION_MAX - head.length)) };
}

// ── Reading GitHub ──

function headers(token: string, accept = "application/vnd.github+json") {
  return { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
}

async function rest(url: string, token: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<{ status: number; json?: any; text?: string }> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: { ...headers(token, init.accept), ...(init.body ? { "Content-Type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (response.status === 404) return { status: 404 };
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return init.accept?.includes("raw") ? { status: response.status, text: await response.text() } : { status: response.status, json: await response.json() };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Modes (from each parent tree's entries) and texts (a renamed file's two sides), by GraphQL "sha:path"
 * expressions, a hundred to a call. A mode reads as git prints it ("100644"); a binary or cut text reads null.
 */
async function readObjects(repository: string, token: string, wants: Array<{ sha: string; path: string; text: boolean }>): Promise<{ mode: (sha: string, path: string) => string | null; text: (sha: string, path: string) => string | null }> {
  const [owner, name] = repository.split("/");
  const trees = new Map<string, Map<string, string>>();
  const texts = new Map<string, string | null>();
  const asks = [
    ...[...new Set(wants.map((w) => `${w.sha}:${dirOf(w.path)}`))].map((e) => ({ e, kind: "tree" as const })),
    ...[...new Set(wants.filter((w) => w.text).map((w) => `${w.sha}:${w.path}`))].map((e) => ({ e, kind: "blob" as const })),
  ];
  for (let i = 0; i < asks.length; i += 100) {
    const chunk = asks.slice(i, i + 100);
    const vars = chunk.map((_, j) => `$e${j}: String!`).join(", ");
    const fields = chunk.map((_, j) => `o${j}: object(expression: $e${j}) { ... on Tree { entries { name mode } } ... on Blob { text isBinary isTruncated } }`).join("\n");
    const variables: Record<string, string> = { owner, name };
    chunk.forEach((a, j) => { variables[`e${j}`] = a.e; });
    const r = await rest(`${GITHUB}/graphql`, token, { method: "POST", body: { query: `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`, variables } });
    if (r.json?.errors?.length) throw new Error(`GitHub GraphQL: ${r.json.errors[0]?.message ?? "error"}`);
    const repo = r.json?.data?.repository ?? {};
    chunk.forEach((a, j) => {
      const o = repo[`o${j}`];
      if (a.kind === "tree") trees.set(a.e, new Map((o?.entries ?? []).map((x: any) => [String(x.name), Number(x.mode).toString(8)])));
      else texts.set(a.e, o && !o.isBinary && !o.isTruncated && typeof o.text === "string" ? o.text : null);
    });
  }
  return {
    mode: (sha, path) => trees.get(`${sha}:${dirOf(path)}`)?.get(baseOf(path)) ?? null,
    text: (sha, path) => texts.get(`${sha}:${path}`) ?? null,
  };
}

/** GitHub's entries completed with what the rebuild needs from each side, for the paths `keep` selects. */
async function withSides(repository: string, token: string, files: PRPath[], base: string, head: string, keep: (p: string) => boolean): Promise<GitHubFile[]> {
  const chosen = files.filter((f) => pathsOf(f).some(keep));
  const wants = chosen.flatMap((f) => {
    const old = f.previous_filename ?? f.filename;
    const renamed = f.status === "renamed" && !!f.previous_filename;
    return [
      ...(f.status === "added" ? [] : [{ sha: base, path: old, text: renamed }]),
      ...(f.status === "removed" ? [] : [{ sha: head, path: f.filename, text: renamed }]),
    ];
  });
  const read = wants.length ? await readObjects(repository, token, wants) : null;
  return chosen.map((f) => {
    const old = f.previous_filename ?? f.filename;
    const renamed = f.status === "renamed" && !!f.previous_filename;
    return {
      ...f,
      base_mode: f.status === "added" ? null : read!.mode(base, old),
      head_mode: f.status === "removed" ? null : read!.mode(head, f.filename),
      ...(renamed ? { base_text: read!.text(base, old), head_text: read!.text(head, f.filename) } : {}),
    };
  });
}

async function prMessages(repository: string, token: string, prNumber: number): Promise<string[]> {
  const commits: any[] = [];
  for (let page = 1; page <= 3; page++) {
    const r = await rest(`${GITHUB}/repos/${repository}/pulls/${prNumber}/commits?per_page=100&page=${page}`, token);
    const batch: any[] = r.json ?? [];
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  return commits.map((c) => String(c.commit?.message ?? ""));
}

export type PullRead =
  | { open: false }
  | { open: true; head_sha: string; unreadable: string; judges?: string[] }
  | { open: true; head_sha: string; judged: string[]; key: string; judges: string[]; reverts: boolean; requested_by?: string; area_owner?: string };

/** Everything the rule reads from GitHub for one pull request. Never throws past the head: a failure is unreadable. */
export async function readPull(repository: string, prNumber: number, token: string, judgesPath: string): Promise<PullRead> {
  const pr = await fetchPRFiles(repository, prNumber, token);
  if (pr.state !== "open" || !pr.head_sha) return { open: false };
  const head = pr.head_sha;
  const main = pr.default_branch ?? pr.base_ref ?? "main";
  try {
    const judgesFile = await rest(`${GITHUB}/repos/${repository}/contents/${encodePath(judgesPath)}?ref=${encodeURIComponent(main)}`, token, { accept: "application/vnd.github.raw+json" });
    if (judgesFile.status === 404) return { open: true, head_sha: head, unreadable: `${judgesPath} on ${main}` };
    const judges = parseJudges(judgesFile.text ?? "");
    if (!pr.complete || pr.paths.length >= PR_FILES_CAP) return { open: true, head_sha: head, unreadable: "every file (over 3,000, or GitHub cut the list short)", judges };
    const compare = await rest(`${GITHUB}/repos/${repository}/compare/${encodeURIComponent(main)}...${head}`, token);
    const mb: string | undefined = compare.json?.merge_base_commit?.sha;
    if (!mb) return { open: true, head_sha: head, unreadable: `the merge base with ${main}`, judges };
    // A `name#key` entry judges a file of that name only when its key's value changed: read both sides to decide.
    const changed = pr.paths.flatMap(pathsOf);
    const byKey = changed.filter((p) => !isJudged(p, judges) && keyEntriesFor(p, judges).length);
    const sides = byKey.length ? await readObjects(repository, token, byKey.flatMap((p) => [{ sha: mb, path: p, text: true }, { sha: head, path: p, text: true }])) : null;
    const keyHits = byKey.filter((p) => keyEntriesFor(p, judges).some((k) => keyChanged(sides!.text(mb, p), sides!.text(head, p), k.key)));
    const judged = judgedPaths(changed, judges, keyHits);
    const rebuilt = pathDiffsOf(await withSides(repository, token, pr.paths, mb, head, (p) => judged.includes(p)), (p) => judged.includes(p));
    if ("unreadable" in rebuilt) return { open: true, head_sha: head, unreadable: `${rebuilt.unreadable}'s diff`, judges };
    const key = await diffKey(rebuilt.diffs);
    const messages = await prMessages(repository, token, prNumber);
    const asker = requestedBy(messages);
    const ownersPath = `${judgesPath.includes("/") ? judgesPath.slice(0, judgesPath.lastIndexOf("/") + 1) : ""}owners.txt`;
    const ownersFile = await rest(`${GITHUB}/repos/${repository}/contents/${encodePath(ownersPath)}?ref=${encodeURIComponent(main)}`, token, { accept: "application/vnd.github.raw+json" });
    const owner = ownersFile.status === 404 ? null : ownerOf(judged.length ? judged : changed, parseOwners(ownersFile.text ?? ""));
    return { open: true, head_sha: head, judged, key, judges, reverts: messages.some((m) => revertedShas(m).length > 0), ...(asker ? { requested_by: asker } : {}), ...(owner ? { area_owner: owner } : {}) };
  } catch (error) {
    return { open: true, head_sha: head, unreadable: `GitHub (${(error instanceof Error ? error.message : String(error)).slice(0, 60)})` };
  }
}

/** Why a token cannot post statuses, or null when it can or nobody recorded what it may do. */
export function statusesRefusal(permissions: Record<string, string> | undefined): string | null {
  if (!permissions) return null;
  return permissions.statuses === "write" ? null : "codecast's GitHub app has no statuses: write here yet; the status was not posted";
}

// ── The work ──

export type Evaluation = { opted: false } | { opted: true; open: false } | ({ opted: true; open: true; head_sha: string; context: string; posted: boolean; unchanged?: boolean; reason?: string } & ApprovalVerdict);

async function evaluateCore(ctx: any, args: { repository: string; pr_number: number; post: boolean }): Promise<Evaluation & { token?: string }> {
  const repository = normalizeRepository(args.repository);
  const gate: any = await ctx.runQuery(internal.changeApprovals.gateFor, { repository });
  if (!gate) return { opted: false };
  const minted: { token: string; permissions?: Record<string, string> } = await ctx.runAction(internal.githubApp.getInstallationToken, { installation_id: gate.installation_id });
  const read = await readPull(repository, args.pr_number, minted.token, gate.judges_path);
  if (!read.open) return { opted: true, open: false };
  const { unchanged, ...verdict }: ApprovalVerdict & { context: string; unchanged: boolean } = await ctx.runMutation(internal.changeApprovals.settle, {
    repository, pr_number: args.pr_number, head_sha: read.head_sha,
    ...("unreadable" in read ? { unreadable: read.unreadable } : {
      judged: read.judged, key: read.key,
      ...(read.reverts ? { reverts: true } : {}),
      ...(read.requested_by ? { requested_by: read.requested_by } : {}),
      ...(read.area_owner ? { area_owner: read.area_owner } : {}),
    }),
    ...(read.judges ? { judges: read.judges } : {}),
  });
  const done = { opted: true as const, open: true as const, head_sha: read.head_sha, token: minted.token, ...verdict };
  if (!args.post) return { ...done, posted: false };
  const refusal = statusesRefusal(minted.permissions);
  const unposted = async (reason: string) => {
    await ctx.runMutation(internal.changeApprovals.noteUnposted, { repository, pr_number: args.pr_number, head_sha: read.head_sha, reason: fit(reason) });
    return { ...done, posted: false, reason };
  };
  if (refusal) return unposted(refusal);
  // Idempotent: a head whose status already reads this way is not posted again.
  if (unchanged) return { ...done, posted: true, unchanged: true };
  try {
    await rest(`${GITHUB}/repos/${repository}/statuses/${read.head_sha}`, minted.token, { method: "POST", body: { state: verdict.state, description: verdict.description, context: verdict.context } });
  } catch (error) {
    return unposted(`status not posted: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...done, posted: true };
}

/** Work a pull request's status out and, with `post`, post it from the app. Every trigger lands here. */
export const evaluate = internalAction({
  args: { repository: v.string(), pr_number: v.number(), post: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Evaluation> => {
    const { token: _token, ...out } = await evaluateCore(ctx, { ...args, post: args.post ?? true }) as any;
    return out;
  },
});

/** How many open pull requests one sweep reads per repository, and how far apart their reads start. */
const SWEEP_PRS = 100;
const SWEEP_SPACING_MS = 3_000;

/**
 * The periodic sweep (crons.ts): every opted-in repository's open pull requests are worked out again, so a dropped
 * webhook or a deploy mid-event never leaves one pending with nobody told. Reads start a few seconds apart, and a
 * status that already reads the same on its head is not posted again.
 */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<{ repositories: number; pulls: number }> => {
    const repositories: string[] = await ctx.runQuery(internal.changeApprovals.optedRepositories, {});
    let n = 0;
    for (const repository of repositories) {
      const numbers: number[] = await ctx.runQuery(internal.changeApprovals.openNumbers, { repository });
      for (const pr_number of numbers.slice(0, SWEEP_PRS)) {
        await ctx.scheduler.runAfter(n++ * SWEEP_SPACING_MS, internal.changeApprovals.evaluate, { repository, pr_number, post: true });
      }
    }
    return { repositories: repositories.length, pulls: n };
  },
});

/** Every repository an installation opted in, once each. */
export const optedRepositories = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const rows = await ctx.db.query("github_app_installations").take(1000);
    return [...new Set(rows.filter((r) => !r.suspended_at).flatMap((r) => (r.approval_gate ?? []).map((g) => normalizeRepository(g.repository))))];
  },
});

/** Re-post every open pull request of a repository: main's judges file changed under them. */
export const evaluateOpen = internalAction({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<{ posted: number }> => {
    const numbers: number[] = await ctx.runQuery(internal.changeApprovals.openNumbers, { repository: normalizeRepository(args.repository) });
    for (const n of numbers) await ctx.scheduler.runAfter(0, internal.changeApprovals.evaluate, { repository: args.repository, pr_number: n, post: true });
    return { posted: numbers.length };
  },
});

export const openNumbers = internalQuery({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<number[]> => {
    const rows = await ctx.db.query("pull_requests").withIndex("by_repository_state", (q) => q.eq("repository", args.repository).eq("state", "open")).take(500);
    return [...new Set(rows.map((r) => r.number))];
  },
});

export const gateFor = internalQuery({
  args: { repository: v.string() },
  handler: async (ctx, args) => gateOf(ctx, args.repository),
});

const nameOf = async (ctx: any, userId: Id<"users"> | undefined): Promise<string> => {
  const u: any = userId ? await ctx.db.get(userId) : null;
  return u?.name || u?.github_username || u?.email?.split("@")[0] || "a person";
};

/**
 * The review's mechanism answer, when it counts: recorded by the reviewer's own session in this attempt
 * (orgLineMerge.recordReviewVerdictCore), on a reviewer station codecast saw finish, about this head or one the run's
 * own rebase made of it. Anything less is not said.
 */
export function mechanismOf(run: any, head: string): boolean | null {
  const r = run.review_verdict;
  const attempt = runAttempt(run);
  if (!r || r.attempt !== attempt || typeof r.mechanism !== "boolean") return null;
  const station = (run.node_statuses ?? []).find((n: any) => n.node_id === r.node_id);
  if (!station || station.status !== "completed" || !station.session_id || (station.started_at ?? 0) < attempt) return null;
  if (!coveredHeads(run, attempt, r.head_sha).has(head)) return null;
  return r.mechanism;
}

/**
 * The records half of a status: the run behind the pull request and its review's answer, a Ship press tied to the
 * judged diff of the first head the run pushed, an untied card Ship tied to the diff it now has, the approvals for
 * this diff, and the verdict, stored on the pull request's rows.
 */
export const settle = internalMutation({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    head_sha: v.string(),
    unreadable: v.optional(v.string()),
    judged: v.optional(v.array(v.string())),
    key: v.optional(v.string()),
    reverts: v.optional(v.boolean()),
    requested_by: v.optional(v.string()),
    area_owner: v.optional(v.string()),
    judges: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<ApprovalVerdict & { context: string; unchanged: boolean }> => {
    const repository = normalizeRepository(args.repository);
    const gate = await gateOf(ctx, repository);
    if (!gate) throw new Error(`${repository} is not opted in to the approval status`);
    if (args.judges && JSON.stringify(args.judges) !== JSON.stringify(gate.judges ?? null)) {
      const row = await ctx.db.get(gate.installation_row);
      if (row) await ctx.db.patch(row._id, { approval_gate: (row.approval_gate ?? []).map((g) => (normalizeRepository(g.repository) === repository ? { ...g, judges: args.judges } : g)) });
    }
    const run: any = await ctx.db.query("workflow_runs").withIndex("by_pr", (q) => q.eq("pr.repository", repository).eq("pr.number", args.pr_number)).order("desc").first();
    const key = args.key;
    const judged = args.judged ?? [];

    if (run && key !== undefined) {
      const press: any = run.pressed_approval_id ? await ctx.db.get(run.pressed_approval_id) : null;
      if (press && !press.revoked_at && press.judged_key === undefined && run.pr?.first_head_sha === args.head_sha && judged.every((p) => press.files.includes(p))) {
        await ctx.db.patch(press._id, { pr_number: args.pr_number, judged_key: key, head_sha: args.head_sha });
      }
      const held: Doc<"change_approvals">[] = await ctx.db.query("change_approvals").withIndex("by_run", (q) => q.eq("workflow_run_id", run._id)).collect();
      for (const a of held) {
        if (a.source === "card" && !a.revoked_at && a.judged_key === undefined) await ctx.db.patch(a._id, { pr_number: args.pr_number, judged_key: key, head_sha: args.head_sha });
      }
    }

    const approvals: Doc<"change_approvals">[] = key === undefined ? [] : (await ctx.db
      .query("change_approvals")
      .withIndex("by_pr_key", (q) => q.eq("repository", repository).eq("pr_number", args.pr_number).eq("judged_key", key))
      .collect()).filter((a) => !a.revoked_at).sort((a, b) => b.created_at - a.created_at);
    const cardRow = approvals.find((a) => a.source === "card");
    const pressRow = approvals.find((a) => a.source === "ship_press");
    // A change Cam asked for: the engineer's yes, given before anything was built (ct-98540), is the approval, and any
    // card is that engineer's, never Cam's.
    const camAsked = isCamRequest(args.requested_by);
    const engineerYes = camAsked && run ? await preBuildYes(ctx, run) : null;
    const card = cardRow
      ? { who: await nameOf(ctx, cardRow.user_id), ref: cardRow.decision_id ? ((await ctx.db.get(cardRow.decision_id))?.short_id ?? "its card") : "its card" }
      : engineerYes ? { who: await nameOf(ctx, engineerYes.user_id), ref: engineerYes.ref } : null;
    const press = pressRow ? { who: await nameOf(ctx, pressRow.user_id) } : null;
    // Who a card goes to, by name (cards to a person, never a role): the presser for judged files their press did not
    // list; else the work's Requested-by person, the session's owner, the area's owner. A mechanism: an engineer, or
    // the area's owner. Codecast cannot yet tell an engineer from anyone else, so it names the area's owner beside.
    const presser: any = run?.pressed_approval_id ? await ctx.db.get(run.pressed_approval_id) : null;
    const spawner: any = run?.spawner_conversation_id ? await ctx.db.get(run.spawner_conversation_id) : null;
    const presserName = presser ? await nameOf(ctx, presser.user_id) : null;
    const judgedNeeds = camAsked
      ? (engineerYes ? await nameOf(ctx, engineerYes.user_id) : null) ?? args.area_owner ?? "an engineer"
      : presserName ?? args.requested_by ?? (spawner ? await nameOf(ctx, spawner.user_id) : null) ?? args.area_owner ?? "a person";
    const needs = { judged: judgedNeeds, mechanism: camAsked && engineerYes ? judgedNeeds : `an engineer${args.area_owner ? ` or ${args.area_owner}` : ""}` };
    const role: any = run?.org_role_id ? await ctx.db.get(run.org_role_id) : null;
    const captainRevert = !!args.reverts && isReleaseCaptain(role);

    const facts: ApprovalFacts = args.unreadable !== undefined
      ? { opted: true, unreadable: args.unreadable }
      : { opted: true, judged, ...(captainRevert ? { captain_revert: true } : {}), mechanism: run ? mechanismOf(run, args.head_sha) : null, card, press, needs };
    const verdict = decide(facts)!;

    const rows = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q) => q.eq("repository", repository).eq("number", args.pr_number)).collect();
    // The same words already posted on this head: posting them again changes nothing on GitHub (the sweep's case).
    const before = rows[0]?.approval;
    const unchanged = !!before && before.head_sha === args.head_sha && before.state === verdict.state && before.description === verdict.description;
    for (const pr of rows) {
      await patchPullRequest(ctx, pr._id, {
        approval: {
          head_sha: args.head_sha, state: verdict.state, description: verdict.description,
          ...(key !== undefined ? { judged_key: key, judged_files: judged } : {}),
          ...(run ? { run_id: run._id } : {}),
        },
      });
    }
    return { ...verdict, context: approvalContext(gate.mode), unchanged };
  },
});

/** The status was worked out and could not be posted: the pull request says why. */
export const noteUnposted = internalMutation({
  args: { repository: v.string(), pr_number: v.number(), head_sha: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q) => q.eq("repository", args.repository).eq("number", args.pr_number)).collect();
    for (const pr of rows) {
      if (pr.approval?.head_sha !== args.head_sha) continue;
      await patchPullRequest(ctx, pr._id, { approval: { ...pr.approval, state: "unposted", description: args.reason } });
    }
  },
});

// ── Merging as the app ──

/**
 * The one merge that answers to the rule: codecast works the status out again, posts it, and merges with its app's
 * installation token only when its own verdict and GitHub's `approval` status on `expected_head_sha` both say
 * success. Never a person's token, never a bypass. prCli.merge (`cast pr merge --as-app`) checks the caller first.
 */
export const mergeAsApp = internalAction({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    expected_head_sha: v.string(),
    method: v.optional(v.union(v.literal("merge"), v.literal("squash"), v.literal("rebase"))),
    commit_title: v.optional(v.string()),
    commit_message: v.optional(v.string()),
    delete_branch: v.optional(v.boolean()),
    head_ref: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ merged: boolean; sha?: string; branch_deleted?: boolean; error?: string }> => {
    const repository = normalizeRepository(args.repository);
    const out: any = await evaluateCore(ctx, { repository, pr_number: args.pr_number, post: true });
    if (!out.opted) return { merged: false, error: `${repository} is not opted in to codecast's approval status, so codecast's app does not merge it` };
    if (!out.open) return { merged: false, error: `${repository}#${args.pr_number} is not open` };
    if (out.head_sha !== args.expected_head_sha) return { merged: false, error: `the head is ${out.head_sha.slice(0, 10)}, not ${args.expected_head_sha.slice(0, 10)}: look again before merging` };
    if (out.state !== "success") return { merged: false, error: `not approved: ${out.description}` };
    const statuses = await rest(`${GITHUB}/repos/${repository}/commits/${args.expected_head_sha}/statuses?per_page=100`, out.token);
    const latest = (statuses.json ?? []).find((s: any) => s.context === out.context);
    if (latest?.state !== "success") return { merged: false, error: `GitHub's ${out.context} status on ${args.expected_head_sha.slice(0, 10)} is ${latest?.state ?? "missing"}${out.reason ? ` (${out.reason})` : ""}` };
    const result: any = await ctx.runAction(internal.githubApi.mergePullRequest, {
      repository, pr_number: args.pr_number, method: args.method ?? "squash", github_access_token: out.token,
      expected_head_sha: args.expected_head_sha, delete_branch: args.delete_branch, head_ref: args.head_ref,
      ...(args.commit_title !== undefined ? { commit_title: args.commit_title } : {}),
      ...(args.commit_message !== undefined ? { commit_message: args.commit_message } : {}),
    });
    return { merged: !!result.merged, sha: result.sha, branch_deleted: result.branch_deleted };
  },
});

// ── A person's part ──

async function personFor(ctx: any, apiToken?: string): Promise<Id<"users">> {
  const userId = apiToken ? (await verifyApiToken(ctx, apiToken))?.userId : await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthorized");
  return userId as Id<"users">;
}

/**
 * A person pressed Ship in codecast on a confirm that listed `files`, the session's judged files, beside the button.
 * The press waits for the run it asks for (lib/changeApprovalRows.claimPress) and is tied to the judged diff of the
 * first head that run pushes, when every judged path there is among these files.
 */
export const recordPress = mutation({
  args: { conversation_id: v.id("conversations"), files: v.array(v.string()) },
  handler: async (ctx, args): Promise<Id<"change_approvals"> | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const user: any = await ctx.db.get(userId);
    if (!user || user.is_bot) throw new Error("Only a person's press approves");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx as any, userId, conversation as any))) throw new Error("Not found");
    const repository = repositoryKeyOfRemote((conversation as any).git_remote_url);
    if (!repository || !(await gateOf(ctx, repository))) return null;
    return await ctx.db.insert("change_approvals", {
      repository: normalizeRepository(repository),
      files: [...new Set(args.files)].slice(0, 500),
      user_id: userId,
      source: "ship_press",
      conversation_id: args.conversation_id,
      created_at: Date.now(),
    });
  },
});

/** The judges file's entries for Ship's confirm, as last read from main; null when the repository is not opted in. */
export const judgesFor = query({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<string[] | null> => {
    if (!(await getAuthUserId(ctx))) return null;
    const gate = await gateOf(ctx, args.repository);
    return gate ? gate.judges ?? [] : null;
  },
});

/** An admin opts a repository in ("shadow", then "required") or out ("off"). */
export const setGate = mutation({
  args: {
    api_token: v.optional(v.string()),
    installation_id: v.number(),
    repository: v.string(),
    judges_path: v.optional(v.string()),
    mode: v.union(v.literal("shadow"), v.literal("required"), v.literal("off")),
  },
  handler: async (ctx, args) => {
    const userId = await personFor(ctx, args.api_token);
    const row = await ctx.db.query("github_app_installations").withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id)).first();
    if (!row) throw new Error(`No installation ${args.installation_id}`);
    await requireInstallationRevoker(ctx, userId, row);
    const repository = normalizeRepository(args.repository);
    const others = (row.approval_gate ?? []).filter((g) => normalizeRepository(g.repository) !== repository);
    if (args.mode !== "off" && !args.judges_path?.trim()) throw new Error("Name the judges file on the default branch (judges_path)");
    const entry = args.mode === "off" ? [] : [{ repository, judges_path: args.judges_path!.trim(), mode: args.mode }];
    await ctx.db.patch(row._id, { approval_gate: [...others, ...entry], updated_at: Date.now() });
    if (args.mode !== "off") await ctx.scheduler.runAfter(0, internal.changeApprovals.evaluateOpen, { repository });
    return { repository, mode: args.mode };
  },
});

