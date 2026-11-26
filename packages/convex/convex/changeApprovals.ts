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
//   carry      an approval holds while the patch id (lib/judgedDiff.ts) of the diff it approved is unchanged: a rebase
//              keeps it, a changed diff asks again. Judged-file approvals (a press, a card about the judged files)
//              bind to the judged diff; one that read the change whole (a mechanism, no review to say, the run's
//              card) binds to the pull request's whole diff, so any code change asks it again.
//   mechanism  the reviewer's answer counts only from a reviewer station codecast saw finish, on the head (or a head
//              the run's own rebase made of it). Until one exists the status is pending: there is no default.
//   no run     a pull request no codecast run is behind (Dependabot's, a bot's, one opened in GitHub's UI) is read by
//              codecast's automatic review (lib/automaticReview.ts), one model call on the server over the diff of the
//              head being evaluated. One evaluation claims the head (claimAutomaticReview) and the first answer stored
//              for it counts; with none (no mechanism file, too large, a failure, no budget) a person reads it whole,
//              and a mechanism or a verdict other than ship holds for every later head of the pull request.
//   revert     a Release Captain's revert (the run's role, and git's revert line on its commits) merges on CI's
//              required checks alone; no revert is recognised from its diff.
//   who        the status names the person a card goes to: a judged file the press did not list, the person who
//              pressed; other work, its Requested-by person, else the session's owner, else the area's owner from the
//              owners file beside the judges file (`<path-prefix> <user id> <name>`), else the pull request's
//              author; a mechanism, an engineer or that owner.
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
import { approvalContext, askerOf, changeJudgedFiles, gateOf, isCam, isReleaseCaptain, mayReadGate, preBuildYes } from "./lib/changeApprovalRows";
import { askReviewForMechanism, cardPeople, cardStale, postApprovalCard, withdrawApprovalCard, type CardReason } from "./lib/changeApprovalCards";
import { AUTOMATIC_REVIEW_CLAIM_MS, MECHANISM_FILE, reviewHead, type AutomaticReview } from "./lib/automaticReview";
import { automaticReviewValidator } from "./lib/automaticReviewValidator";
import type { CallScope } from "./modelCalls";
import { diffKey, isJudged, judgedPaths, keyChanged, keyEntriesFor, ownerOf, parseJudges, parseOwners, pathDiffsOf, pathsOf, requestedBy, revertedShas, type GitHubFile } from "./lib/judgedDiff";

const GITHUB = "https://api.github.com";
/** GitHub cuts a status description at 140 characters. */
const DESCRIPTION_MAX = 140;

// ── The rule ──

export type ApprovalFacts =
  | { opted: false }
  | { opted: true; unreadable: string; card?: { who: string; ref: string } | null }
  | {
      opted: true;
      judged: string[];
      /** A revert the Release Captain's run made: CI's required checks alone decide it. */
      captain_revert?: boolean;
      /**
       * The codecast run behind the pull request, whose review gives the mechanism answer: "live" while its reviewer can
       * still record one (the run is pending or running), "ended" once it cannot; false with no run behind it.
       */
      run: "live" | "ended" | false;
      /** The review's answer: true a mechanism, false not, null not said (or not yet seen finished). */
      mechanism: boolean | null;
      /** The answer is codecast's automatic review's, with no run behind the pull request. */
      automatic?: boolean;
      /** The automatic review gave no answer for this head, and why. */
      review_failed?: string;
      /** The automatic review's verdict was not ship: a person reads it whole, with its reason. */
      objection?: "changes" | "rejected";
      /** An earlier head's automatic review called it a mechanism or objected: every later head is a person's to read. */
      held?: string;
      /** A person's yes on a card that read the change whole, for this whole diff: it covers a mechanism too. */
      card?: { who: string; ref: string } | null;
      /** What covers this judged diff's files, never a mechanism: a Ship press, a card that asked about them, an engineer's pre-build yes. */
      press?: { who: string; ref?: string } | null;
      /** Who a card goes to, by name, for each question a person may be asked. */
      needs: { judged: string; mechanism: string; review: string; objection?: string };
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
  const approved = (c: { who: string; ref: string }): ApprovalVerdict => ({ state: "success", description: fit(`approved by ${c.who} (${c.ref})`) });
  if ("unreadable" in f) return f.card ? approved(f.card) : { state: "pending", description: fit(`could not read ${f.unreadable}; a person approves`) };
  if (f.captain_revert) return { state: "success", description: "the Release Captain's revert: CI's required checks decide" };
  // No codecast run, and no automatic review has answered for this head yet (another evaluation is reading it): it waits,
  // and nobody is asked. A review that never answers fails closed (claimAutomaticReview), never waits for ever.
  if (!f.run) {
    if (f.card) return approved(f.card);
    return { state: "pending", description: "waiting for codecast's automatic review" };
  }
  if (f.mechanism === null) {
    if (f.run === "live") return { state: "pending", description: "waiting for the review's mechanism answer" };
    // The run ended with no answer, so its reviewer can no longer give one: a person reads it whole (the card). The
    // automatic review that could not answer fails closed the same way, saying why.
    if (f.card) return approved(f.card);
    return { state: "pending", description: fit(`needs a review by ${f.needs.review}: ${f.review_failed ? `the automatic review could not answer (${f.review_failed})` : "the review gave no mechanism answer"}`) };
  }
  if (f.objection) return f.card ? approved(f.card) : { state: "pending", description: fit(`needs a review by ${f.needs.objection ?? f.needs.review}: the automatic review ${f.objection === "rejected" ? "rejected it" : "asked for changes"}`) };
  if (f.held) return f.card ? approved(f.card) : { state: "pending", description: fit(`needs a review by ${f.needs.objection ?? f.needs.review}: ${f.held}`) };
  if (!f.judged.length && !f.mechanism) return { state: "success", description: f.automatic ? "no judged paths; the automatic review: not a mechanism" : "no judged paths; the review: not a mechanism" };
  if (f.card) return approved(f.card);
  if (f.mechanism) return { state: "pending", description: fit(`needs ${f.needs.mechanism}: the review called it a mechanism`) };
  if (f.press) return { state: "success", description: fit(`approved by ${f.press.who} (${f.press.ref ?? "Ship press"})`) };
  const head = `needs ${f.needs.judged}: edits `;
  return { state: "pending", description: fit(head + pathList(f.judged, DESCRIPTION_MAX - head.length)) };
}


/**
 * The question a pending status puts to a person, which their approval card asks, or null when it waits on nobody: a
 * review that can still give its mechanism answer is asked again, never a person, and a pull request no run is behind
 * waits for the automatic review's answer. A review that can no longer answer is a person's card.
 */
export function cardReason(f: ApprovalFacts): CardReason | null {
  if (!f.opted || f.card) return null;
  if ("unreadable" in f) return "unreadable";
  if (f.captain_revert) return null;
  if (!f.run) return null;
  if (f.mechanism === null) return f.run === "ended" ? "review" : null;
  if (f.objection || f.held) return "objection";
  if (f.mechanism) return "mechanism";
  return f.judged.length && !f.press ? "judged" : null;
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
  return init.accept?.includes("raw") || init.accept?.includes("diff") ? { status: response.status, text: await response.text() } : { status: response.status, json: await response.json() };
}

/** The newest status GitHub shows on a commit under one context (its list is newest first), or undefined. */
async function shownStatus(repository: string, sha: string, context: string, token: string): Promise<{ state?: string; description?: string } | undefined> {
  const statuses = await rest(`${GITHUB}/repos/${repository}/commits/${sha}/statuses?per_page=100`, token);
  return (Array.isArray(statuses.json) ? statuses.json : []).find((s: any) => s?.context === context);
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

/**
 * The key of the pull request's whole diff against its merge base (patch-id --verbatim, as the judged diff's): what a
 * card that read the change whole approves, so a pure rebase carries it and any code change asks again. When a file's
 * diff cannot be rebuilt (binary, too large, unreadable), undefined: settle then keys it to the head, so every push
 * asks again.
 */
async function wholeKey(repository: string, token: string, paths: PRPath[], base: string, head: string): Promise<string | undefined> {
  try {
    const all = pathDiffsOf(await withSides(repository, token, paths, base, head, () => true), () => true);
    return "unreadable" in all ? undefined : await diffKey(all.diffs);
  } catch {
    return undefined;
  }
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

/** Who a card may go to, as GitHub and main's files beside the judges file name them. */
export type PullPeople = {
  title: string;
  author_login: string | null;
  /** The area's owner by main's owners file (lib/judgedDiff parseOwners), or null when the file or its area is missing. */
  area_owner: { user_id: string; name: string } | null;
  /** Main's engineers file: one `<codecast user id> <name>` a line; null when GitHub could not be read (none is not []). */
  engineers: Array<{ user_id: string; name: string }> | null;
};

export type PullRead =
  | { open: false }
  | { open: true; head_sha: string; unreadable: string; judges?: string[]; people: PullPeople }
  | {
      open: true; head_sha: string; judged: string[]; key: string; whole_key?: string; judges: string[]; reverts: boolean; requested_by?: string; people: PullPeople;
      base_sha: string; paths: string[]; default_branch: string;
      /** Where main's mechanism file is (lib/automaticReview MECHANISM_FILE, beside the judges file): read only when the automatic review runs. */
      mechanism_path: string;
    };

/** Main's engineers file: `<codecast user id> <name>` a line, blank and "#" lines skipped. */
export function parseEngineers(text: string): Array<{ user_id: string; name: string }> {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).flatMap((l) => {
    const m = /^(\S+)\s+(.+)$/.exec(l);
    return m ? [{ user_id: m[1], name: m[2].trim() }] : [];
  });
}

/** Everything the rule reads from GitHub for one pull request. Never throws past the head: a failure is unreadable. */
export async function readPull(repository: string, prNumber: number, token: string, judgesPath: string): Promise<PullRead> {
  const pr = await fetchPRFiles(repository, prNumber, token);
  if (pr.state !== "open" || !pr.head_sha) return { open: false };
  const head = pr.head_sha;
  const main = pr.default_branch ?? pr.base_ref ?? "main";
  const changed = pr.paths.flatMap(pathsOf);
  const beside = (name: string) => `${judgesPath.includes("/") ? judgesPath.slice(0, judgesPath.lastIndexOf("/") + 1) : ""}${name}`;
  const onMain = async (path: string) => {
    const r = await rest(`${GITHUB}/repos/${repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(main)}`, token, { accept: "application/vnd.github.raw+json" });
    return r.status === 404 ? null : r.text ?? "";
  };
  const people: PullPeople = { title: pr.title ?? "", author_login: pr.author_login ?? null, area_owner: null, engineers: null };
  try {
    const [ownersText, engineersText] = await Promise.all([onMain(beside("owners.txt")), onMain(beside("engineers.txt"))]);
    const owners = ownersText === null ? [] : parseOwners(ownersText);
    people.engineers = engineersText === null ? [] : parseEngineers(engineersText);
    people.area_owner = ownerOf(changed, owners);
    const judgesText = await onMain(judgesPath);
    if (judgesText === null) return { open: true, head_sha: head, unreadable: `${judgesPath} on ${main}`, people };
    const judges = parseJudges(judgesText);
    if (!pr.complete || pr.paths.length >= PR_FILES_CAP) return { open: true, head_sha: head, unreadable: "every file (over 3,000, or GitHub cut the list short)", judges, people };
    const compare = await rest(`${GITHUB}/repos/${repository}/compare/${encodeURIComponent(main)}...${head}`, token);
    const mb: string | undefined = compare.json?.merge_base_commit?.sha;
    if (!mb) return { open: true, head_sha: head, unreadable: `the merge base with ${main}`, judges, people };
    // A `name#key` entry judges a file of that name only when its key's value changed: read both sides to decide.
    const byKey = changed.filter((p) => !isJudged(p, judges) && keyEntriesFor(p, judges).length);
    const sides = byKey.length ? await readObjects(repository, token, byKey.flatMap((p) => [{ sha: mb, path: p, text: true }, { sha: head, path: p, text: true }])) : null;
    const keyHits = byKey.filter((p) => keyEntriesFor(p, judges).some((k) => keyChanged(sides!.text(mb, p), sides!.text(head, p), k.key)));
    const judged = judgedPaths(changed, judges, keyHits);
    // The area is the judged files' when there are any.
    if (judged.length) people.area_owner = ownerOf(judged, owners) ?? people.area_owner;
    const rebuilt = pathDiffsOf(await withSides(repository, token, pr.paths, mb, head, (p) => judged.includes(p)), (p) => judged.includes(p));
    if ("unreadable" in rebuilt) return { open: true, head_sha: head, unreadable: `${rebuilt.unreadable}'s diff`, judges, people };
    const key = await diffKey(rebuilt.diffs);
    const whole_key = await wholeKey(repository, token, pr.paths, mb, head);
    const messages = await prMessages(repository, token, prNumber);
    const asker = requestedBy(messages);
    // The Captain's exemption is for a pull request of reverts only: one other commit and it is judged like any.
    return {
      open: true, head_sha: head, judged, key, ...(whole_key ? { whole_key } : {}), judges, reverts: messages.length > 0 && messages.every((m) => revertedShas(m).length > 0), ...(asker ? { requested_by: asker } : {}), people,
      base_sha: mb, paths: changed, default_branch: main, mechanism_path: beside(MECHANISM_FILE),
    };
  } catch (error) {
    return { open: true, head_sha: head, unreadable: `GitHub (${(error instanceof Error ? error.message : String(error)).slice(0, 60)})`, people };
  }
}

/**
 * The diff of exactly `head` against its merge base with the default branch, as GitHub renders it, with one retry; or
 * why it could not be read. GitHub refuses a diff too large to render, which reads as a failure.
 */
async function headDiff(repository: string, base: string, head: string, token: string): Promise<string | { error: string }> {
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await rest(`${GITHUB}/repos/${repository}/compare/${base}...${head}`, token, { accept: "application/vnd.github.diff" });
      if (r.status === 404) return { error: "GitHub has no such comparison" };
      return r.text ?? "";
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }
  return { error };
}

/** A file on the default branch: its text, null when it is not there, or why it could not be read. */
async function mainFile(repository: string, main: string, path: string, token: string): Promise<string | null | { error: string }> {
  try {
    const r = await rest(`${GITHUB}/repos/${repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(main)}`, token, { accept: "application/vnd.github.raw+json" });
    return r.status === 404 ? null : r.text ?? "";
  } catch (e) {
    return { error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
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
  // No codecast run behind it: the automatic review reads this head, once. The evaluation that claims the head calls the
  // model; one that loses the claim settles as waiting, and a claim that never finished fails closed.
  let automatic: AutomaticReview | undefined;
  if (!("unreadable" in read)) {
    const claim: Claim = await ctx.runMutation(internal.changeApprovals.claimAutomaticReview, { repository, pr_number: args.pr_number, head_sha: read.head_sha });
    if (claim.action === "stale") automatic = claim.record;
    if (claim.action === "claimed") {
      automatic = await reviewHead(ctx, claim.scope, {
        repository, head_sha: read.head_sha, listed: read.paths, diff: await headDiff(repository, read.base_sha, read.head_sha, minted.token),
        mechanism_definition: await mainFile(repository, read.default_branch, read.mechanism_path, minted.token), mechanism_path: read.mechanism_path,
      }, Date.now());
    }
  }
  const verdict: ApprovalVerdict & { context: string } = await ctx.runMutation(internal.changeApprovals.settle, {
    repository, pr_number: args.pr_number, head_sha: read.head_sha,
    ...(automatic ? { automatic } : {}),
    ...("unreadable" in read ? { unreadable: read.unreadable } : {
      judged: read.judged, key: read.key, ...(read.whole_key ? { whole_key: read.whole_key } : {}),
      ...(read.reverts ? { reverts: true } : {}),
      ...(read.requested_by ? { requested_by: read.requested_by } : {}),
    }),
    ...(read.judges ? { judges: read.judges } : {}),
    people: {
      title: read.people.title,
      ...(read.people.author_login ? { author_login: read.people.author_login } : {}),
      ...(read.people.area_owner ? { area_owner: read.people.area_owner } : {}),
      // Not read is not "no engineers": the gate keeps the list it last read.
      ...(read.people.engineers ? { engineers: read.people.engineers } : {}),
    },
  });
  const done = { opted: true as const, open: true as const, head_sha: read.head_sha, token: minted.token, ...verdict };
  if (!args.post) return { ...done, posted: false };
  const refusal = statusesRefusal(minted.permissions);
  const unposted = async (reason: string) => {
    await ctx.runMutation(internal.changeApprovals.noteUnposted, { repository, pr_number: args.pr_number, head_sha: read.head_sha, reason: fit(reason) });
    return { ...done, posted: false, reason };
  };
  if (refusal) return unposted(refusal);
  try {
    // Idempotent against what GitHub shows now, never a record of an earlier post: overlapping evaluations can post
    // in either order, and whichever landed last, the next evaluation (the sweep at the latest) reads it and corrects it.
    const shown = await shownStatus(repository, read.head_sha, verdict.context, minted.token);
    if (shown?.state === verdict.state && shown.description === verdict.description) return { ...done, posted: true, unchanged: true };
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
 * status GitHub already shows the same on its head is not posted again.
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

type Claim =
  | { action: "run_behind" | "kept" | "waiting" }
  | { action: "stale"; record: AutomaticReview }
  | { action: "claimed"; scope: CallScope | null };

/** What an earlier head's answer holds over the next head: a mechanism or an objection, never a failure. */
export function heldBy(prior: AutomaticReview | undefined): string | undefined {
  if (!prior) return undefined;
  if (prior.held) return prior.held;
  if (prior.pending || prior.failed) return undefined;
  const said = prior.mechanism ? "called it a mechanism" : prior.verdict === "rejected" ? "rejected it" : prior.verdict === "changes" ? "asked for changes" : null;
  return said ? `the automatic review of an earlier head (${prior.head_sha.slice(0, 10)}) ${said}` : undefined;
}

/**
 * One evaluation claims a head before it calls the model, so a pull request's two webhooks at once (Dependabot's opened
 * and labeled), or an author re-triggering it, buy one answer, and the first stands. With a run behind the pull request,
 * nothing to do; an answer or failure already stored for the head is kept; a fresh claim of another evaluation waits;
 * a claim older than AUTOMATIC_REVIEW_CLAIM_MS never finished and fails closed. The claim carries what an earlier
 * head's answer holds.
 */
export const claimAutomaticReview = internalMutation({
  args: { repository: v.string(), pr_number: v.number(), head_sha: v.string() },
  handler: async (ctx, args): Promise<Claim> => {
    const repository = normalizeRepository(args.repository);
    const now = Date.now();
    const run = await ctx.db.query("workflow_runs").withIndex("by_pr", (q) => q.eq("pr.repository", repository).eq("pr.number", args.pr_number)).first();
    if (run) return { action: "run_behind" };
    const rows = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q) => q.eq("repository", repository).eq("number", args.pr_number)).collect();
    const stored = rows[0]?.approval?.automatic;
    if (stored?.head_sha === args.head_sha) {
      if (!stored.pending) return { action: "kept" };
      if (now - stored.at < AUTOMATIC_REVIEW_CLAIM_MS) return { action: "waiting" };
      return { action: "stale", record: { head_sha: args.head_sha, failed: true, reason: "the automatic review that took this head never finished", ...(stored.held ? { held: stored.held } : {}), at: now } };
    }
    const held = heldBy(stored);
    const claim: AutomaticReview = { head_sha: args.head_sha, pending: true, reason: "reading", ...(held ? { held } : {}), at: now };
    for (const row of rows) {
      await patchPullRequest(ctx, row._id, { approval: { ...(row.approval ?? { head_sha: args.head_sha, state: "pending" as const, description: "waiting for codecast's automatic review" }), automatic: claim } });
    }
    const gate = await gateOf(ctx, repository);
    const installation: any = gate ? await ctx.db.get(gate.installation_row) : null;
    const scope: CallScope | null = installation?.team_id ? { workspace: `team:${installation.team_id}`, team_id: installation.team_id }
      : installation?.scope_user_id ? { workspace: `user:${installation.scope_user_id}` } : null;
    return { action: "claimed", scope };
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
 * judged diff of the first head the run pushed, the approvals for this diff (a card approves only the diff it was
 * stamped with), and the verdict, stored on the pull request's rows.
 */
export const settle = internalMutation({
  args: {
    repository: v.string(),
    pr_number: v.number(),
    head_sha: v.string(),
    unreadable: v.optional(v.string()),
    judged: v.optional(v.array(v.string())),
    key: v.optional(v.string()),
    whole_key: v.optional(v.string()),
    reverts: v.optional(v.boolean()),
    requested_by: v.optional(v.string()),
    judges: v.optional(v.array(v.string())),
    automatic: v.optional(automaticReviewValidator),
    people: v.optional(v.object({
      title: v.string(),
      author_login: v.optional(v.string()),
      area_owner: v.optional(v.object({ user_id: v.string(), name: v.string() })),
      engineers: v.optional(v.array(v.object({ user_id: v.string(), name: v.string() }))),
    })),
  },
  handler: async (ctx, args): Promise<ApprovalVerdict & { context: string }> => {
    const repository = normalizeRepository(args.repository);
    const gate = await gateOf(ctx, repository);
    if (!gate) throw new Error(`${repository} is not opted in to the approval status`);
    const readEngineers = args.people?.engineers;
    if ((args.judges && JSON.stringify(args.judges) !== JSON.stringify(gate.judges ?? null)) || (readEngineers && JSON.stringify(readEngineers) !== JSON.stringify(gate.engineers ?? null))) {
      const row = await ctx.db.get(gate.installation_row);
      if (row) await ctx.db.patch(row._id, { approval_gate: (row.approval_gate ?? []).map((g) => (normalizeRepository(g.repository) === repository ? { ...g, ...(args.judges ? { judges: args.judges } : {}), ...(readEngineers ? { engineers: readEngineers } : {}) } : g)) });
    }
    const run: any = await ctx.db.query("workflow_runs").withIndex("by_pr", (q) => q.eq("pr.repository", repository).eq("pr.number", args.pr_number)).order("desc").first();
    const key = args.key;
    const judged = args.judged ?? [];

    if (run && key !== undefined) {
      const press: any = run.pressed_approval_id ? await ctx.db.get(run.pressed_approval_id) : null;
      if (press && !press.revoked_at && press.judged_key === undefined && run.pr?.first_head_sha === args.head_sha && judged.every((p) => press.files.includes(p))) {
        await ctx.db.patch(press._id, { pr_number: args.pr_number, judged_key: key, head_sha: args.head_sha });
      }
    }

    // A change Cam asked for (codecast's own record of who asked, never a commit trailer): an engineer's in-person yes
    // before the build approves its judged files, bound to the judged diff the run first pushed; never a mechanism.
    const engineers = args.people?.engineers ?? gate.engineers ?? [];
    const camAsked = !!run && isCam(await askerOf(ctx, run));
    const engineerYes = camAsked ? await preBuildYes(ctx, run, engineers) : null;
    if (engineerYes && key !== undefined && run.pr?.first_head_sha === args.head_sha) {
      const tied = await ctx.db.query("change_approvals").withIndex("by_run", (q) => q.eq("workflow_run_id", run._id)).collect();
      if (!tied.some((a) => a.source === "engineer_yes" && String(a.decision_id) === String(engineerYes.decision_id))) {
        await ctx.db.insert("change_approvals", {
          repository, pr_number: args.pr_number, judged_key: key, files: judged, user_id: engineerYes.user_id, source: "engineer_yes",
          workflow_run_id: run._id, ...(run.task_id ? { task_id: run.task_id } : {}), decision_id: engineerYes.decision_id, head_sha: args.head_sha, created_at: Date.now(),
        });
      }
    }

    // Two keys an approval binds to. The judged diff's: a Ship press, an engineer's pre-build yes and a card that asked
    // about the judged files cover those files while their diff is unchanged, never a mechanism. The whole diff's: a card
    // that read the change whole (a mechanism, no review to say, the run's own card) covers all of it while the whole
    // diff is unchanged, so a pure rebase carries it and any code change asks again. Unread, the head stands for it.
    // Whole keys are namespaced (`whole:`, `head:`) apart from judged-diff keys: when every changed file is judged the two
    // patch ids are equal, and a yes to the judged files must never read as a yes to the change whole.
    const wholeKey = args.whole_key ? `whole:${args.whole_key}` : `head:${args.head_sha}`;
    const keyed = async (k: string | undefined): Promise<Doc<"change_approvals">[]> => (k === undefined ? [] : (await ctx.db
      .query("change_approvals")
      .withIndex("by_pr_key", (q) => q.eq("repository", repository).eq("pr_number", args.pr_number).eq("judged_key", k))
      .collect()).filter((a) => !a.revoked_at).sort((a, b) => b.created_at - a.created_at));
    const approvals = await keyed(key);
    const wholeRow = (await keyed(wholeKey)).find((a) => a.source === "card");
    const pressRow = approvals.find((a) => a.source === "ship_press");
    const yesRow = approvals.find((a) => a.source === "engineer_yes");
    const judgedCardRow = approvals.find((a) => a.source === "card");
    const refOf = async (a: Doc<"change_approvals">) => (a.decision_id ? ((await ctx.db.get(a.decision_id))?.short_id ?? "its card") : "its card");
    const card = wholeRow ? { who: await nameOf(ctx, wholeRow.user_id), ref: await refOf(wholeRow) } : null;
    const press = pressRow ? { who: await nameOf(ctx, pressRow.user_id) }
      : judgedCardRow ? { who: await nameOf(ctx, judgedCardRow.user_id), ref: await refOf(judgedCardRow) }
      : yesRow ? { who: await nameOf(ctx, yesRow.user_id), ref: `${await refOf(yesRow)} before the build` } : null;
    const rows = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q) => q.eq("repository", repository).eq("number", args.pr_number)).collect();
    const pr = rows[0] ?? null;
    const before = pr?.approval;
    // Who each question goes to: a person, never a role (lib/changeApprovalCards.ts).
    const to = await cardPeople(ctx, {
      teamId: pr?.team_id ?? run?.team_id, run, camAsked, area_owner: args.people?.area_owner,
      // With no run behind it the area's owner is asked: a commit's Requested-by line is an agent's word, not codecast's record.
      requested_by: run ? args.requested_by : undefined, author_login: args.people?.author_login, engineers, engineerYes,
    });
    const needs = { judged: to.judged.name, mechanism: to.mechanism.name, review: to.review.name, objection: to.objection.name };
    const role: any = run?.org_role_id ? await ctx.db.get(run.org_role_id) : null;
    const captainRevert = !!args.reverts && isReleaseCaptain(role);
    // With no run behind it, the automatic review's answer stands in for a run's, for the head it read alone. The first
    // answer stored for a head stands: a later one (a second evaluation, a re-run) never replaces it.
    const kept = before?.automatic?.head_sha === args.head_sha ? before.automatic : undefined;
    const given = args.automatic?.head_sha === args.head_sha && !args.automatic.pending ? args.automatic : undefined;
    const answer = kept && !kept.pending ? kept : given ? { ...given, ...(kept?.held && !given.held ? { held: kept.held } : {}) } : undefined;
    const auto = !run ? answer : undefined;
    const mechanism = run ? mechanismOf(run, args.head_sha) : auto && !auto.failed && typeof auto.mechanism === "boolean" ? auto.mechanism : null;
    // A reviewer records its answer only while its run is pending or running (orgLineMerge.recordReviewVerdictCore).
    const runState = !run ? (auto ? "ended" : false) : run.status === "pending" || run.status === "running" ? "live" : "ended";
    const objection = auto && mechanism !== null && (auto.verdict === "changes" || auto.verdict === "rejected") ? auto.verdict : undefined;

    const facts: ApprovalFacts = args.unreadable !== undefined
      ? { opted: true, unreadable: args.unreadable, card }
      : {
          opted: true, judged, ...(captainRevert ? { captain_revert: true } : {}), run: runState, mechanism, card, press, needs,
          ...(auto ? { automatic: true } : {}), ...(auto?.failed ? { review_failed: auto.reason } : {}), ...(objection ? { objection } : {}),
          ...(auto?.held && !auto.failed ? { held: auto.held } : {}),
        };
    const verdict = decide(facts)!;
    const now = Date.now();

    // A review that finished without a mechanism answer is asked again, once per head, while it can still answer.
    const askedReview = run && runState === "live" && mechanism === null && before?.review_asked !== args.head_sha
      && (await askReviewForMechanism(ctx, run, args.head_sha, `${repository}#${args.pr_number}`, runAttempt(run)));
    // The one card a person is asked, per judged diff and question; the one it replaces is taken back first.
    const reason: CardReason | null = cardReason(facts);
    // A card about the judged files binds to their diff; any other reads the change whole.
    const cardKey = reason === "judged" && key !== undefined ? key : wholeKey;
    const stale = cardStale(before?.card_key, { diffs: reason ? [cardKey] : [key, wholeKey].filter((k): k is string => !!k), reason, success: verdict.state === "success" });
    if (stale && before?.card_id) await withdrawApprovalCard(ctx, before.card_id, now, "The pull request's judged diff or what it waits on changed; a new card asks if anything is needed.");
    const posted = reason ? await postApprovalCard(ctx, {
      repository, pr_number: args.pr_number, head_sha: args.head_sha, key: cardKey, judged, reason, to: to[reason], run, pr,
      title: args.people?.title ?? pr?.title ?? "", before_key: before?.card_key, now,
      // The automatic review's own words are what the card shows, its reason or why it gave none.
      ...(auto ? { words: [auto.held ? `Held: ${auto.held}.` : null, `${auto.failed ? "The automatic review could not answer" : `The automatic review of this head (${auto.verdict}, ${auto.mechanism ? "a mechanism" : "not a mechanism"})`}: ${auto.reason}`].filter(Boolean).join("\n\n") } : {}),
    }) : null;

    for (const row of rows) {
      await patchPullRequest(ctx, row._id, {
        approval: {
          head_sha: args.head_sha, state: verdict.state, description: verdict.description,
          // Both keys as approvals bind to them: the run's own card stamps them (lib/changeApprovalRows approvalStampFor).
          ...(key !== undefined ? { judged_key: key, judged_files: judged, whole_key: wholeKey } : {}),
          ...(run ? { run_id: run._id } : {}),
          ...(typeof mechanism === "boolean" ? { mechanism } : {}),
          ...(captainRevert ? { captain_revert: true } : {}),
          ...(posted ? { card_key: posted.card_key, ...(posted.card_id ? { card_id: posted.card_id } : {}) } : before?.card_key && !stale ? { card_key: before.card_key, ...(before.card_id ? { card_id: before.card_id } : {}) } : {}),
          ...(askedReview ? { review_asked: args.head_sha } : before?.review_asked ? { review_asked: before.review_asked } : {}),
          ...(before?.engineer_told ? { engineer_told: true } : {}),
          ...(answer ? { automatic: answer } : before?.automatic ? { automatic: before.automatic } : {}),
        },
      });
    }
    return { ...verdict, context: approvalContext(gate.mode) };
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
    const latest = await shownStatus(repository, args.expected_head_sha, out.context, out.token);
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

/**
 * What Ship lists beside its button for a session's change: the judges file's entries as last read from main, and the
 * judged files the change touches with the sessions that wrote them (lib/changeApprovalRows changeJudgedFiles). Only
 * for someone who can see the session and is in the workspace the opted-in installation belongs to; null otherwise,
 * and when not opted in.
 */
export const shipList = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<{ judges: string[]; files: Array<{ path: string; writers: string[] }> } | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx as any, userId, conversation as any))) return null;
    const repository = repositoryKeyOfRemote(conversation.git_remote_url);
    const gate = repository ? await gateOf(ctx, repository) : null;
    if (!gate || !(await mayReadGate(ctx, userId, gate))) return null;
    return { judges: gate.judges ?? [], files: await changeJudgedFiles(ctx, conversation, gate) };
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

