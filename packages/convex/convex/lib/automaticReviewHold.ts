// Codecast's automatic review of a pull request no codecast run is behind (ct-100350 item 5), as the approval status
// (changeApprovals.ts) uses it. The model call itself is lib/automaticReview.ts; this is what surrounds it.
//
//   claim      one evaluation claims a head before it calls the model, so a pull request's two webhooks at once
//              (Dependabot's opened and labeled), or an author re-triggering it, buy one answer, and the first answer
//              stored for a head is the one that counts.
//   hold       a mechanism answer, on any head, holds the pull request (approval.held): every evaluation, a codecast
//              run's included, is a person's until a person approves it on a card posted while it was held
//              (changeApprovalRows mayClearHold). A failure never holds: it fails closed to a person for its own head.
//   approvals  with no run behind the pull request, an approval counts only from codecast's own approval card, by
//              someone it asked when it was posted who did not write the change.
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { normalizeRepository } from "@codecast/shared/contracts";
import { patchPullRequest } from "../prShepherd";
import type { CallScope } from "../modelCalls";
import { gateOf, prAuthor } from "./changeApprovalRows";
import { AUTOMATIC_REVIEW_CLAIM_MS, reviewHead, type AutomaticReview } from "./automaticReview";
import { GITHUB, encodePath, rest } from "./githubRest";

/** A pull request this new waits for its automatic review: a codecast run opening it reports it in that time. */
const AUTOMATIC_REVIEW_GRACE_MS = 2 * 60_000;

export type Claim =
  | { action: "run_behind" | "kept" | "waiting" | "no_record" }
  | { action: "too_soon"; in_ms: number }
  | { action: "stale"; record: AutomaticReview }
  | { action: "claimed"; scope: CallScope | null };

/**
 * The claim on a head (changeApprovals.claimAutomaticReview). With a run behind the pull request, nothing to do; an
 * answer or failure already stored for the head is kept; a fresh claim of another evaluation waits; a claim older than
 * AUTOMATIC_REVIEW_CLAIM_MS never finished and fails closed. A pull request codecast keeps no row for (a personal
 * install, a repository not shared with the team) has nowhere to hold a claim or an answer: nothing is called, and it
 * fails closed. What a hold holds is the pull request's (approval.held), never the claim's.
 */
export async function claimHead(ctx: { db: any }, args: { repository: string; pr_number: number; head_sha: string }): Promise<Claim> {
  const repository = normalizeRepository(args.repository);
  const now = Date.now();
  const run = await ctx.db.query("workflow_runs").withIndex("by_pr", (q: any) => q.eq("pr.repository", repository).eq("pr.number", args.pr_number)).first();
  if (run) return { action: "run_behind" };
  const rows: Doc<"pull_requests">[] = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q: any) => q.eq("repository", repository).eq("number", args.pr_number)).collect();
  if (!rows.length) return { action: "no_record" };
  // Opened moments ago: the run that opened it may not have reported it yet. The evaluation set for then claims it.
  const age = now - (rows[0].created_at ?? 0);
  if (age < AUTOMATIC_REVIEW_GRACE_MS) return { action: "too_soon", in_ms: AUTOMATIC_REVIEW_GRACE_MS - age };
  const stored = rows[0].approval?.automatic;
  if (stored?.head_sha === args.head_sha) {
    if (!stored.pending) return { action: "kept" };
    if (now - stored.at < AUTOMATIC_REVIEW_CLAIM_MS) return { action: "waiting" };
    return { action: "stale", record: { head_sha: args.head_sha, failed: true, reason: "the automatic review that took this head never finished", at: now } };
  }
  const claim: AutomaticReview = { head_sha: args.head_sha, pending: true, reason: "reading", at: now };
  for (const row of rows) {
    await patchPullRequest(ctx, row._id, { approval: { ...(row.approval ?? { head_sha: args.head_sha, state: "pending" as const, description: "waiting for codecast's automatic review" }), automatic: claim } });
  }
  const gate = await gateOf(ctx, repository);
  const installation: any = gate ? await ctx.db.get(gate.installation_row) : null;
  const scope: CallScope | null = installation?.team_id ? { workspace: `team:${installation.team_id}`, team_id: installation.team_id }
    : installation?.scope_user_id ? { workspace: `user:${installation.scope_user_id}` } : null;
  return { action: "claimed", scope };
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

/**
 * The automatic review an evaluation brings to settle for one head: the answer it got by claiming the head and calling
 * the model, a stale claim's failure, or a failure where codecast keeps no row; undefined when there is nothing new (a
 * run behind it, an answer kept, another evaluation reading it, or too soon, when an evaluation is set for then).
 */
export async function automaticReviewFor(
  ctx: { runQuery: any; runMutation: any; scheduler: any },
  a: { repository: string; pr_number: number; head_sha: string; base_sha: string; paths: string[]; default_branch: string; mechanism_path: string; token: string },
): Promise<AutomaticReview | undefined> {
  const claim: Claim = await ctx.runMutation(internal.changeApprovals.claimAutomaticReview, { repository: a.repository, pr_number: a.pr_number, head_sha: a.head_sha });
  if (claim.action === "stale") return claim.record;
  if (claim.action === "too_soon") await ctx.scheduler.runAfter(claim.in_ms, internal.changeApprovals.evaluate, { repository: a.repository, pr_number: a.pr_number, post: true });
  if (claim.action === "no_record") {
    return { head_sha: a.head_sha, failed: true, reason: "codecast keeps no record of this pull request to hold an answer (its repository is not shared with a team)", at: Date.now() };
  }
  if (claim.action !== "claimed") return undefined;
  return reviewHead(ctx, claim.scope, {
    repository: a.repository, head_sha: a.head_sha, listed: a.paths, diff: await headDiff(a.repository, a.base_sha, a.head_sha, a.token),
    mechanism_definition: await mainFile(a.repository, a.default_branch, a.mechanism_path, a.token), mechanism_path: a.mechanism_path,
  }, Date.now());
}

/** What an answer holds the pull request to, whatever its head: a mechanism; never a failure or a claim. */
export function holdOf(a: AutomaticReview | undefined): string | undefined {
  return a && !a.pending && !a.failed && a.mechanism ? `the automatic review of ${a.head_sha.slice(0, 10)} called it a mechanism` : undefined;
}

/**
 * The automatic review as settle reads it for `head_sha`: the answer that stands for it (the first stored; else the one
 * this evaluation brought) and the hold a fresh answer newly sets. A second answer for a head counts toward the hold
 * though it never replaces the first. With a run recorded on the pull request before the answer settled, the answer is
 * kept and sets no hold: the run's own review decides now.
 */
export function automaticOutcome(before: Doc<"pull_requests">["approval"], brought: AutomaticReview | undefined, head_sha: string, runBehind: boolean): { answer?: AutomaticReview; newHold?: string } {
  const kept = before?.automatic?.head_sha === head_sha && !before.automatic.pending ? before.automatic : undefined;
  const given = brought?.head_sha === head_sha && !brought.pending ? brought : undefined;
  const newHold = runBehind ? undefined : holdOf(given);
  return { ...(kept ?? given ? { answer: kept ?? given } : {}), ...(newHold ? { newHold } : {}) };
}

/**
 * The approvals that count on a pull request no run is behind: only from codecast's own approval card, by someone it
 * asked when it was posted who did not write the change; never a run's Ship card (a run since detached), never the
 * author's.
 */
export async function countedWithoutRun(ctx: { db: any }, repository: string, prNumber: number, rows: Doc<"change_approvals">[]): Promise<Doc<"change_approvals">[]> {
  const author = await prAuthor(ctx, repository, prNumber);
  const out: Doc<"change_approvals">[] = [];
  for (const a of rows) {
    const d: any = a.decision_id ? await ctx.db.get(a.decision_id) : null;
    if (d?.approval_card && (d.approval?.asked ?? []).some((id: any) => String(id) === String(a.user_id)) && String(a.user_id) !== String(author)) out.push(a);
  }
  return out;
}
