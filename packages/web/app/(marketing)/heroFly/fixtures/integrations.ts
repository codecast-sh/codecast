/**
 * Chapter 10, GitHub: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * Pull request #482 opens with the lead as its shepherd and the two workers
 * linked; Sarah approves it, the four checks go green one by one, and it
 * merges.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { PrCheck, PrReviewRow } from "@/lib/prView";
import type { PrStatus } from "@/store/inboxStore";
import { MIN, OBJECTS, PEOPLE, SESSIONS } from "./story";

/** Where the pull request stands at a moment of the chapter. */
export type PrStage = { approved: boolean; checksPassed: number; ready: boolean; merged: boolean };

export const HEAD_REF = "retry-webhooks";
const REVIEWER = "sarahchen";
const AUTHOR = PEOPLE.me.handle;

const CHECK_NAMES = ["build", "test (unit)", "test (integration)", "typecheck"];

function checks(now: number, passed: number): PrCheck[] {
  return CHECK_NAMES.map((name, i) => ({
    name,
    external_id: `hero-check-${i}`,
    status: i < passed ? "completed" : "in_progress",
    conclusion: i < passed ? "success" : undefined,
    updated_at: now - 20_000 + i * 1_000,
  }));
}

/** Short enough that the page shows the description whole above the timeline, from its first line. */
const BODY = `Failed deliveries retry with exponential backoff, at most 5 attempts, then dead-letter. Queue and backoff in \`${OBJECTS.blame.file}\`; 214 tests pass.`;

/** The pull request row as the page reads it. */
export function pullRequest(now: number, s: PrStage) {
  return {
    _id: "hero-pr1",
    repository: OBJECTS.pr.repository,
    number: OBJECTS.pr.number,
    title: OBJECTS.pr.title,
    body: BODY,
    state: (s.merged ? "merged" : "open") as "merged" | "open",
    draft: false,
    author_github_username: AUTHOR,
    head_ref: HEAD_REF,
    base_ref: "main",
    head_sha: "8f7eb2d41c0a9e3b5d6f7a8b9c0d1e2f3a4b5c6d",
    additions: 412,
    deletions: 38,
    changed_files: 9,
    commits_count: 3,
    checks: checks(now, s.checksPassed),
    review_decision: s.approved ? "approved" : "review_required",
    requested_reviewers: [REVIEWER],
    mergeable_state: s.ready ? "clean" : "blocked",
    labels: [{ name: "webhooks", color: "0e8a16" }],
    shepherd_conversation_id: SESSIONS.lead.shortId,
    shepherd_enabled: !s.merged,
    shepherd_state: s.merged ? "merged" : s.ready ? "ready" : s.checksPassed < CHECK_NAMES.length ? "ci_pending" : "review_pending",
    linked_session_ids: [SESSIONS.lead.shortId, SESSIONS.api.shortId, SESSIONS.ui.shortId],
    task_ids: [OBJECTS.task.shortId],
    github_created_at: now - 6 * MIN,
  };
}

export const CHECK_COUNT = CHECK_NAMES.length;

/** Sarah's review, once she has approved. */
export function reviews(now: number, s: PrStage): PrReviewRow[] {
  if (!s.approved) return [];
  return [{ _id: "hero-rv1", state: "approved", body: "Five attempts over about thirty minutes covers the ledger restarts. Ship it.", submitted_at: now - 40_000, author_github_username: REVIEWER }];
}

/** What GitHub reported, as the external events the timeline lists. */
export function events(now: number, s: PrStage) {
  const base = { source: "github", repository: OBJECTS.pr.repository, pr_number: OBJECTS.pr.number };
  return [
    {
      ...base,
      _id: "hero-ev-push",
      kind: "push",
      title: `3 commits to ${HEAD_REF}`,
      actor_login: AUTHOR,
      conversation_id: SESSIONS.api.id,
      task_short_id: OBJECTS.task.shortId,
      meta: { branch: HEAD_REF, commit_count: 3 },
      created_at: now - 5 * MIN,
    },
    ...(s.merged ? [{ ...base, _id: "hero-ev-merged", kind: "pr_merged", title: `${HEAD_REF} into main`, actor_login: AUTHOR, created_at: now - 2_000 }] : []),
  ];
}

/** The chip the merge carries west to the published page. */
export const MERGED_STATUS: PrStatus = {
  pr_id: "hero-pr1",
  repository: OBJECTS.pr.repository,
  number: OBJECTS.pr.number,
  title: OBJECTS.pr.title,
  state: "merged",
  at: 0,
};

export const entities: Record<string, EntityFixture> = {};
