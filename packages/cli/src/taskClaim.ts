// `cast task start` claims a task. Who the claim belongs to depends on who ran
// it. A person at a terminal is the assignee. An agent inside a session runs
// under the owner's token, so "me" would resolve to the owner: the task would
// land on the human board, enroll the owner in the thread, and notify the
// owner that they assigned themselves. The agent's claim is the session
// binding (conversation_id) alone, never an assignee.
//
// The session detector is the same one that stamps source:"agent" on create,
// so the two decisions can never disagree.

export function buildTaskStartBody(shortId: string, sessionId: string | null): Record<string, any> {
  const body: Record<string, any> = { short_id: shortId, status: "in_progress" };
  if (sessionId) body.conversation_id = sessionId;
  else body.assignee = "me";
  return body;
}

// ─── Structured handoff and review verdict (docs/architecture/the-line.md L2, L3)

export const HANDOFF_STATUSES = ["done", "blocked", "needs_context"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const REVIEW_VERDICTS = ["approve", "changes", "reject"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface HandoffInput {
  status: HandoffStatus;
  evidence: string;
  files?: string[];
  pr?: string;
  /** Page slugs attached as evidence (the-line.md L6), listed in the comment. */
  pages?: string[];
}

/** `--files a,b` → ["a", "b"]; blanks dropped. */
export function parseFilesFlag(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const files = raw.split(",").map((f) => f.trim()).filter(Boolean);
  return files.length ? files : undefined;
}

export function parseHandoffStatus(raw: string | undefined): HandoffStatus {
  if (!raw || !(HANDOFF_STATUSES as readonly string[]).includes(raw)) {
    throw new Error(`--status must be one of ${HANDOFF_STATUSES.join(", ")}`);
  }
  return raw as HandoffStatus;
}

export function parseReviewVerdict(raw: string | undefined): ReviewVerdict {
  if (!raw || !(REVIEW_VERDICTS as readonly string[]).includes(raw)) {
    throw new Error(`verdict must be one of ${REVIEW_VERDICTS.join(", ")}`);
  }
  return raw as ReviewVerdict;
}

// A hand ends its turn with a handoff: the task moves to in_review carrying
// what was done and how it was checked, so the role reads the task, never the
// transcript. Rides /cli/work/update; the comment body is a second call.
export function buildTaskHandoffBody(shortId: string, sessionId: string | null, input: HandoffInput): Record<string, any> {
  if (!input.evidence.trim()) throw new Error("--evidence is required (what you verified, or why you stopped)");
  const body: Record<string, any> = {
    short_id: shortId,
    status: "in_review",
    execution_status: input.status,
    verification_evidence: input.evidence,
  };
  if (input.files?.length) body.files_changed = input.files;
  if (sessionId) body.conversation_id = sessionId;
  return body;
}

export function handoffCommentText(input: HandoffInput): string {
  const lines = [`Handoff: ${input.status}`, "", input.evidence.trim()];
  if (input.files?.length) lines.push("", `Files: ${input.files.join(", ")}`);
  if (input.pr) lines.push("", `PR: ${input.pr}`);
  if (input.pages?.length) lines.push("", `Pages: ${input.pages.map((slug) => `/a/${slug}`).join(", ")}`);
  return lines.join("\n");
}

// The verdict moves the task and records who judged it in the same write:
// approve closes it, changes sends it back to the implementer, reject reopens
// it as blocked so a person decides what happens next.
export const VERDICT_STATUS: Record<ReviewVerdict, string> = {
  approve: "done",
  changes: "in_progress",
  reject: "open",
};

export function buildTaskVerdictBody(shortId: string, sessionId: string | null, verdict: ReviewVerdict, note?: string): Record<string, any> {
  const body: Record<string, any> = {
    short_id: shortId,
    status: VERDICT_STATUS[verdict],
    review_verdict: verdict,
  };
  if (verdict === "reject") body.execution_status = "blocked";
  if (note?.trim()) body.review_note = note.trim();
  if (sessionId) body.conversation_id = sessionId;
  return body;
}

export function verdictCommentText(verdict: ReviewVerdict, note?: string): string {
  return note?.trim() ? `Verdict: ${verdict}\n\n${note.trim()}` : `Verdict: ${verdict}`;
}
