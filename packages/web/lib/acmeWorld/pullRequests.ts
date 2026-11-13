// Acme's pull requests: the webhook retries PR the lead session opened
// (acme/api#482, checks green, approved by Maya, shepherded by the lead), and
// the HMAC signing PR (acme/api#485, one check red of ten, Maya's review
// asking for changes, linked to Alex's API session). Rows are written into
// the store's pullRequests collection (what the inbox, the phone and the
// timeline read) and answered to the PR page's own queries.
// Mobile's Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { HOUR, MIN, PEOPLE, SESSIONS, TEAM_ID, cid } from "./world";

export const REPO = "acme/api";
export const PR_RETRY = { _id: cid("prretry482"), number: 482 };
export const PR_HMAC = { _id: cid("prhmac485"), number: 485 };

const RETRY_PATCH = `@@ -1,12 +1,38 @@
 import { signed } from "./sign";
+import { enqueue } from "./queue";
+
+/** 2s, 4s, 8s, 16s with up to 20% jitter; the fifth failure dead-letters. */
+export const MAX_ATTEMPTS = 5;
+
+export function backoff(attempt: number): number {
+  const base = 2_000 * 2 ** (attempt - 1);
+  return base + Math.random() * base * 0.2;
+}

 export async function deliver(event: WebhookEvent) {
   const res = await fetch(event.endpoint, signed(event));
   return res.status;
 }
+
+export async function retry(event: WebhookEvent, attempt = 1) {
+  const status = await deliver(event);
+  if (status < 500 && status !== 429) return { status, attempt };
+  if (attempt >= MAX_ATTEMPTS) return deadLetter(event, status);
+  await enqueue(event, { delayMs: backoff(attempt), attempt: attempt + 1 });
+  return { status, attempt, retrying: true };
+}
`;

const HOOKS_PATCH = `@@ -16,4 +16,5 @@
 export const router = Router();

 router.post("/v2/hooks", receive);
+router.post("/v2/hooks/retry", idempotent(retry));
`;

const TEST_PATCH = `@@ -0,0 +1,14 @@
+describe("retry", () => {
+  it("retries a 502 with backoff", async () => {
+    mockDeliver([502, 200]);
+    expect(await retry(event)).toEqual({ status: 200, attempt: 2 });
+  });
+  it("dead-letters after the fifth failure", async () => {
+    mockDeliver([500, 500, 500, 500, 500]);
+    expect(await retry(event)).toMatchObject({ deadLettered: true });
+  });
+  it("never retries a 4xx", async () => {
+    mockDeliver([404]);
+    expect(await retry(event)).toEqual({ status: 404, attempt: 1 });
+  });
+});
`;

const CHECK_NAMES = ["typecheck", "lint", "unit", "integration", "e2e: checkout", "e2e: dashboard", "build", "migrations", "bundle size", "CodeQL"];

const checks = (now: number, failed: string | null) =>
  CHECK_NAMES.map((name, i) => ({
    name,
    status: "completed",
    conclusion: name === failed ? "failure" : "success",
    url: `https://github.com/${REPO}/actions/runs/${8800 + i}`,
    updated_at: now - 20 * MIN + i * MIN,
    event: "pull_request",
    app: name === "CodeQL" ? "github-code-scanning" : "github-actions",
  }));

const commit = (sha: string, message: string, ago: number, now: number) => ({
  sha,
  message,
  author_login: "alexrivera",
  author_name: PEOPLE.me.name,
  author_avatar_url: PEOPLE.me.image,
  committed_at: now - ago,
  url: `https://github.com/${REPO}/commit/${sha}`,
});

export const PULL_REQUESTS = (now: number) => [
  {
    _id: PR_RETRY._id,
    _creationTime: now - 3 * HOUR,
    team_id: TEAM_ID,
    github_pr_id: 9_100_482,
    repository: REPO,
    number: PR_RETRY.number,
    title: "Retry failed webhooks with backoff",
    body:
      "Failed webhook deliveries now go to a retry queue instead of being dropped.\n\n- Backoff of 2s, 4s, 8s, 16s with jitter, at most 5 attempts\n- 5xx, 429 and timeouts retry; any other 4xx is final\n- The fifth failure lands in the dead-letter queue with its last response\n\nCloses ct-4182.",
    state: "open",
    draft: false,
    author_github_username: "alexrivera",
    author_avatar_url: PEOPLE.me.image,
    head_ref: "feat/webhook-retry",
    base_ref: "main",
    head_sha: "9f3c2a1e7b",
    linked_session_ids: [SESSIONS.lead._id, SESSIONS.api._id],
    task_ids: ["hero-t1"],
    files: [
      { filename: "src/billing/retry.ts", status: "modified", additions: 26, deletions: 0, changes: 26, patch: RETRY_PATCH },
      { filename: "src/api/hooks.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: HOOKS_PATCH },
      { filename: "src/billing/retry.test.ts", status: "added", additions: 14, deletions: 0, changes: 14, patch: TEST_PATCH },
    ],
    additions: 41,
    deletions: 0,
    changed_files: 3,
    commits_count: 3,
    commits: [
      commit("4a1b9c0d2e", "Add retry queue with exponential backoff", 3 * HOUR, now),
      commit("7d2e5f1a3b", "Dead-letter after the fifth failed attempt", 2 * HOUR, now),
      commit("9f3c2a1e7b", "Route POST /v2/hooks/retry through idempotent()", 40 * MIN, now),
    ],
    files_synced_at: now - 30 * MIN,
    created_at: now - 3 * HOUR,
    updated_at: now - 12 * MIN,
    mergeable: true,
    mergeable_state: "clean",
    behind_by: 0,
    review_decision: "approved",
    requested_reviewers: [],
    labels: [{ name: "webhooks", color: "0e8a16" }],
    assignees: ["alexrivera"],
    unresolved_review_count: 1,
    checks: checks(now, null),
    checks_state: "success",
    shepherd_conversation_id: SESSIONS.lead._id,
    shepherd_enabled: true,
    shepherd_state: "approved",
    shepherd_state_at: now - 12 * MIN,
    shepherd_last_wake_at: now - 12 * MIN,
    shepherd_last_wake_reason: "Maya Ortiz approved",
    shepherd_wake_count: 4,
  },
  {
    _id: PR_HMAC._id,
    _creationTime: now - 5 * HOUR,
    team_id: TEAM_ID,
    github_pr_id: 9_100_485,
    repository: REPO,
    number: PR_HMAC.number,
    title: "Sign webhook payloads with HMAC",
    body: "Every outgoing webhook carries an X-Acme-Signature header (HMAC-SHA256 over the body and timestamp).\n\nCloses ct-4183.",
    state: "open",
    draft: false,
    author_github_username: "alexrivera",
    author_avatar_url: PEOPLE.me.image,
    head_ref: "feat/webhook-hmac",
    base_ref: "main",
    head_sha: "c81f04b6aa",
    linked_session_ids: [SESSIONS.api._id],
    task_ids: ["hero-t2"],
    files: [],
    additions: 118,
    deletions: 9,
    changed_files: 6,
    commits_count: 4,
    created_at: now - 5 * HOUR,
    updated_at: now - 8 * MIN,
    mergeable: true,
    mergeable_state: "unstable",
    behind_by: 0,
    review_decision: "changes_requested",
    requested_reviewers: [],
    labels: [{ name: "security", color: "d93f0b" }],
    assignees: ["alexrivera"],
    unresolved_review_count: 2,
    checks: checks(now, "integration"),
    checks_state: "failure",
    shepherd_conversation_id: SESSIONS.api._id,
    shepherd_enabled: true,
    shepherd_state: "ci_red",
    shepherd_state_at: now - 8 * MIN,
    shepherd_last_wake_at: now - 8 * MIN,
    shepherd_last_wake_reason: "integration failed",
    shepherd_wake_count: 2,
  },
];

const event = (now: number, pr: { _id: string; number: number }, id: string, kind: string, ago: number, title: string, actor: { login: string; image: string }, extra: Record<string, unknown> = {}) => ({
  _id: cid(`ev${id}`),
  team_id: TEAM_ID,
  source: "github",
  repository: REPO,
  kind,
  actor_login: actor.login,
  actor_avatar_url: actor.image,
  title,
  pr_id: pr._id,
  pr_number: pr.number,
  created_at: now - ago,
  ...extra,
});

const ALEX = { login: "alexrivera", image: PEOPLE.me.image };
const MAYA = { login: "maya", image: PEOPLE.maya.image };

export const PR_EVENTS = (now: number) => [
  event(now, PR_RETRY, "r1", "pr_opened", 3 * HOUR, "Retry failed webhooks with backoff", ALEX, { conversation_id: SESSIONS.lead._id }),
  event(now, PR_RETRY, "r2", "pr_synchronize", 2 * HOUR, "Dead-letter after the fifth failed attempt", ALEX, { sha: "7d2e5f1a3b", branch: "feat/webhook-retry", conversation_id: SESSIONS.lead._id }),
  event(now, PR_RETRY, "r3", "pr_synchronize", 40 * MIN, "Route POST /v2/hooks/retry through idempotent()", ALEX, { sha: "9f3c2a1e7b", branch: "feat/webhook-retry", conversation_id: SESSIONS.lead._id }),
  event(now, PR_RETRY, "r4", "pr_check", 20 * MIN, "All 10 checks passed", { login: "github-actions", image: "" }, { sha: "9f3c2a1e7b" }),
  event(now, PR_HMAC, "h1", "pr_opened", 5 * HOUR, "Sign webhook payloads with HMAC", ALEX, { conversation_id: SESSIONS.api._id }),
  event(now, PR_HMAC, "h2", "pr_check_failed", 8 * MIN, "integration failed", { login: "github-actions", image: "" }, { sha: "c81f04b6aa" }),
];

export const PR_REVIEWS = (now: number) => [
  {
    _id: cid("rvretrymaya1"),
    pull_request_id: PR_RETRY._id,
    state: "changes_requested",
    body: "Jitter should scale with the delay, not stay a flat 200ms.",
    submitted_at: now - 70 * MIN,
    author_github_username: "maya",
    github_review_id: 77_001,
    reviewer_user_id: PEOPLE.maya._id,
  },
  {
    _id: cid("rvretrymaya2"),
    pull_request_id: PR_RETRY._id,
    state: "approved",
    body: "Backoff reads right now. Ship it once the checks are green.",
    submitted_at: now - 12 * MIN,
    author_github_username: "maya",
    github_review_id: 77_002,
    reviewer_user_id: PEOPLE.maya._id,
  },
  {
    _id: cid("rvhmacmaya1"),
    pull_request_id: PR_HMAC._id,
    state: "changes_requested",
    body: "Compare signatures in constant time, and include the timestamp in what we sign.",
    submitted_at: now - 30 * MIN,
    author_github_username: "maya",
    github_review_id: 77_010,
    reviewer_user_id: PEOPLE.maya._id,
  },
];

const anchor = (file: string, line: number) => ({ file_path: file, line_number: line, side: "RIGHT" });

export const PR_COMMENTS = (now: number) => [
  {
    _id: cid("ccretry1"),
    pull_request_id: PR_RETRY._id,
    repository: REPO,
    ...anchor("src/billing/retry.ts", 10),
    content: "Jitter should scale with the delay, not stay a flat 200ms.",
    created_at: now - 70 * MIN,
    author_kind: "github" as const,
    author_github_username: "maya",
    author_user_id: PEOPLE.maya._id,
    author_avatar_url: PEOPLE.maya.image,
    github_review_id: 77_001,
    resolved: true,
    resolved_at: now - 40 * MIN,
  },
  {
    _id: cid("ccretry2"),
    pull_request_id: PR_RETRY._id,
    repository: REPO,
    ...anchor("src/billing/retry.ts", 24),
    content: "Does a 410 Gone land here? It should never retry.",
    created_at: now - 15 * MIN,
    author_kind: "github" as const,
    author_github_username: "maya",
    author_user_id: PEOPLE.maya._id,
    author_avatar_url: PEOPLE.maya.image,
    github_review_id: 77_002,
  },
];

const forPr = <T extends { pull_request_id?: string; pr_id?: string }>(rows: T[], id: unknown) =>
  rows.filter((r) => (r.pull_request_id ?? r.pr_id) === id);

const byNumber = (a: any) => PULL_REQUESTS(Date.now()).find((p) => (a?.id ? p._id === a.id : p.repository === a?.repository && p.number === Number(a?.number))) ?? null;

export const PR_ANSWERS: Record<string, (args: any) => unknown> = {
  "pull_requests:getPRsForTimeline": () => PULL_REQUESTS(Date.now()),
  "pull_requests:getPRByNumber": (a) => byNumber(a) ?? undefined,
  "pull_requests:webGet": byNumber,
  "externalEvents:listForPR": (a) => forPr(PR_EVENTS(Date.now()), a?.pr_id),
  "codeComments:listForPR": (a) => forPr(PR_COMMENTS(Date.now()), a?.pull_request_id),
  "reviews:getReviewsForPR": (a) => forPr(PR_REVIEWS(Date.now()), a?.pull_request_id),
};

export function seedAcmePullRequests(s: any, now: number) {
  s.syncTable("pullRequests", PULL_REQUESTS(now));
}

export const PULL_REQUESTS_PART: AcmePart = { name: "pullRequests", seed: seedAcmePullRequests, answers: PR_ANSWERS };
