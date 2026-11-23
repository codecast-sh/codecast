// A pull request as a change reads it (docs/architecture/changes.md CH5): its
// checks, review and merge as lifecycle facts, and when anyone last worked on
// it. The Branches grid, the web pill and the phone pill read a pull request
// through this, so one pull request says the same thing everywhere. Pure, with
// relative imports only.
import { checkLabel, checkOutcome } from "@codecast/shared/contracts";
import type { ChangeFacts } from "./lifecycle";

/** A pull request as the `pullRequests` collection holds it, with its checks when a detail row was laid on. */
export type ChangePullRequest = {
  number: number;
  repository?: string;
  title?: string;
  state: "open" | "closed" | "merged";
  draft?: boolean;
  head_ref?: string;
  head_sha?: string;
  merge_commit_sha?: string;
  merged_at?: number;
  closed_at?: number;
  /** Codecast's row time: every sync bumps it, so it says nothing about anyone's work. */
  updated_at: number;
  created_at?: number;
  /** When its files were last read: on open and on every push to its head. */
  files_synced_at?: number;
  checks_state?: string;
  checks?: ReadonlyArray<{ name: string; status: string; conclusion?: string | null; event?: string }>;
  review_decision?: string;
  mergeable_state?: string;
  /** GitHub's auto-merge, when someone turned it on: the pull request lands itself once its requirements pass. */
  auto_merge?: unknown;
  linked_session_ids?: ReadonlyArray<string>;
  /** Who opened it on GitHub. */
  author_github_username?: string;
};

const CI: Record<string, NonNullable<ChangeFacts["check"]>["ci"]> = { pending: "pending", success: "success", failure: "failure", none: "none" };
const REVIEW: Record<string, NonNullable<ChangeFacts["check"]>["review"]> = { approved: "approved", changes_requested: "changes", review_required: "required" };
const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** The last work on a pull request: opened, pushed to, merged or closed. Never its row's sync time. */
export const prActive = (pr: ChangePullRequest) => Math.max(pr.created_at ?? 0, pr.files_synced_at ?? 0, pr.merged_at ?? 0, pr.closed_at ?? 0) || pr.updated_at;
export const isMerged = (pr: Pick<ChangePullRequest, "state" | "merged_at">) => pr.state === "merged" || !!pr.merged_at;
export const finishedAt = (pr: ChangePullRequest) => (isMerged(pr) ? pr.merged_at : pr.closed_at) ?? pr.updated_at;

/** A pull request's Check: CI from its folded checks state, failing names and the passed count when its checks are held. */
function prCheck(pr: ChangePullRequest): NonNullable<ChangeFacts["check"]> {
  const ci = CI[lower(pr.checks_state)] ?? "none";
  const review = REVIEW[lower(pr.review_decision)] ?? "none";
  if (!pr.checks?.length) return { ci, review };
  const failing = pr.checks.filter((c) => checkOutcome(c) === "failed").map((c) => checkLabel(c));
  const passed = pr.checks.filter((c) => checkOutcome(c) === "passed").length;
  return { ci, review, ...(ci === "failure" && failing.length ? { failing } : {}), passed };
}

function prLand(pr: ChangePullRequest): ChangeFacts["land"] {
  if (isMerged(pr)) return { state: "landed", how: "merged", sha: pr.merge_commit_sha ?? null, at: pr.merged_at ?? null };
  if (pr.state !== "open") return null;
  const state = lower(pr.mergeable_state);
  if (state === "dirty") return { state: "conflict" };
  if (state === "behind") return { state: "behind" };
  return null;
}

/** What a pull request says of its change: checks and review, whether it merged or conflicts, draft, auto-merge, closed. */
export function pullRequestFacts(pr: Omit<ChangePullRequest, "updated_at"> & { updated_at?: number }): Pick<ChangeFacts, "check" | "land" | "draft" | "auto_merge" | "closed"> {
  const merged = isMerged(pr);
  return {
    check: prCheck(pr as ChangePullRequest),
    land: prLand(pr as ChangePullRequest),
    ...(pr.state === "open" && pr.draft ? { draft: true } : {}),
    ...(pr.state === "open" && pr.auto_merge ? { auto_merge: true } : {}),
    ...(pr.state === "closed" && !merged ? { closed: { at: pr.closed_at ?? pr.updated_at ?? 0 } } : {}),
  };
}
