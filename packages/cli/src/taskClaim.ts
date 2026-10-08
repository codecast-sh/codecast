import { ASSIGNEE_MEANS, isRoleAssignee, type AssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import type { ChangeGuide } from "@codecast/shared/contracts/changeGuide";
import { TASK_EFFORTS } from "@codecast/shared/tasks";

// `cast task start` claims a task. Who the claim belongs to depends on who ran
// it. A person at a terminal is the assignee. An agent inside a session runs
// under the owner's token, so "me" would resolve to the owner: the task would
// land on the human board, enroll the owner in the thread, and notify the
// owner that they assigned themselves. The agent's claim is the session
// binding (conversation_id) alone, never an assignee.
//
// The session id must be the caller's OWN, never a guess: the server reads
// the session's role off it (a hand's start hands the task to its role, a
// hand's verdict is refused as its own role's), so a person at a plain
// terminal handed "the one transcript active in the last five minutes" would
// give a task to a hand's role or be refused as a hand. The task verbs read
// `ownSessionId` (the agent's own exported id, then the process walk), which
// is the same witness that stamps source:"agent" on create.

export function buildTaskStartBody(shortId: string, sessionId: string | null, opts: { take?: boolean } = {}): Record<string, any> {
  const body: Record<string, any> = { short_id: shortId, status: "in_progress", ...taskClaimant(sessionId) };
  if (opts.take) body.take = true;
  return body;
}

/** Who a start is for: the session, else the person. */
export function taskClaimant(sessionId: string | null): { conversation_id: string } | { assignee: "me" } {
  return sessionId ? { conversation_id: sessionId } : { assignee: "me" };
}

/** `cast task ready [--claim]`: the ready list's filters and the caller's own
 *  session; with no session the list and the claim are the person's. A
 *  session's frontier holds its own ephemeral tasks only (TG9). A claim takes only a
 *  task that is unassigned or already the caller's (or its role's), and a
 *  task untouched 30 days only with `--stale` (task-graph.md TG7). */
export function buildTaskClaimBody(filters: Record<string, any>, sessionId: string | null, opts: { stale?: boolean } = {}): Record<string, any> {
  return { ...filters, ...(sessionId ? { conversation_id: sessionId } : {}), ...(opts.stale ? { stale: true } : {}) };
}

/** What a claim that took nothing says, naming `--stale` when stale work was
 *  passed over, so an agent told there is nothing left does not stop early. */
export function unclaimedLine(claim: { skipped?: unknown[]; more?: boolean; stale_passed?: number } | null | undefined): string {
  const stale = claim?.stale_passed ? ` ${claim.stale_passed} untouched 30+ days passed over (claim with --stale).` : "";
  if (!claim?.more) return `No ready tasks to claim.${stale}`;
  const passed = claim.skipped?.length ? `, passed over ${claim.skipped.length}` : "";
  return `No task claimed${passed}. More ready tasks exist past those tried: narrow with --plan, --project or -q.${stale}`;
}

// `--model`, `--effort` and `--ephemeral` on create and update (task-graph.md
// TG8, TG9). An effort is checked here so a typo is refused by name rather
// than by the server's validator; "" clears a model or an effort.
export function taskHintBody(options: { model?: string; effort?: string; ephemeral?: boolean }): Record<string, any> {
  const body: Record<string, any> = {};
  if (options.model !== undefined) body.model = options.model;
  if (options.effort !== undefined) {
    if (options.effort && !(TASK_EFFORTS as readonly string[]).includes(options.effort)) {
      throw new Error(`Unknown --effort "${options.effort}". Use: ${TASK_EFFORTS.join(", ")}, or '' to clear`);
    }
    body.effort = options.effort;
  }
  if (options.ephemeral) body.ephemeral = true;
  return body;
}

// `cast task ready`: the frontier comes in the order work should be taken, with
// tasks nobody touched in 30 days last and flagged `stale` (TG7). They fold into
// a count unless asked for.
export function foldStaleTasks<T extends { stale?: boolean }>(tasks: T[], showStale: boolean): { shown: T[]; folded: number } {
  if (showStale) return { shown: tasks, folded: 0 };
  const shown = tasks.filter((t) => !t.stale);
  return { shown, folded: tasks.length - shown.length };
}

/** What ready means (task-graph.md TG1), for `cast task ready` and `ls -r`. */
export const READY_MEANS = "open, nothing they wait on still open (tasks, PRs, decisions, times)";

/** The most rows `cast task ready` asks for. */
export const READY_LIST_LIMIT = 300;

/** The frontier's closing count. A list that filled `READY_LIST_LIMIT` was cut
 *  short, stale rows first since they sort last, so both counts are floors. */
export function readyCountLine(shown: number, folded: number, listed: number): string {
  const floor = listed >= READY_LIST_LIMIT ? "+" : "";
  const foldNote = folded ? `, ${folded}${floor} more untouched 30+ days (--stale lists them)` : "";
  return `${shown}${floor} ready${foldNote}`;
}

// A task has one owning session (convex lib/taskOwner.ts). The start that
// moved the binding names each session it released; one still working is the
// taker's to tell, because it keeps acting on the task until it hears.
export function releasedOwnerLines(result: { released_owners?: Array<{ short_id: string; live: boolean }> } | null | undefined): string[] {
  return (result?.released_owners ?? []).map((o) => o.live
    ? `Took ownership from ${o.short_id}, which is still working: tell it with cast send ${o.short_id} "..."`
    : `Took ownership from ${o.short_id}, which had gone quiet`);
}

// `cast task start` from a session that works for a role hands the task to that
// role (org-roles-run-work.md R5). The server decides, because it holds the
// session's role pointer; the CLI only says what happened.
export function startedForRoleLine(result: { assigned_role?: { handle: string; name: string } | null } | null | undefined): string | null {
  const role = result?.assigned_role;
  return role ? `Assigned to @${role.handle} (${role.name}), the role this session works for` : null;
}

// What `cast task start` prints after "Started": the role that took it, when
// one did, and always what an assignee means (R7), because the start is the
// moment a session reads the task's names and decides what it may do.
export function startedLines(result: Parameters<typeof startedForRoleLine>[0] & Parameters<typeof releasedOwnerLines>[0]): string[] {
  const role = startedForRoleLine(result);
  return [...releasedOwnerLines(result), ...(role ? [role] : []), ASSIGNEE_MEANS];
}

// `cast task ls --chain`: one group per assignee, the person first and then
// each role under them by handle, so a reader sees whose work each row is
// without reading a column. Rows keep the order the server gave them. A role
// is told from a person by the contract's shape on the row (`assignee_info`,
// orgAssignee.ts), never by the look of its label.
export function groupTasksByAssignee<T extends { assignee?: string; assignee_name?: string; assignee_info?: AssigneeInfo | null }>(tasks: T[]): Array<{ label: string; role: boolean; tasks: T[] }> {
  const groups = new Map<string, { label: string; role: boolean; tasks: T[] }>();
  for (const t of tasks) {
    const key = t.assignee ?? "";
    const group = groups.get(key) ?? { label: t.assignee_name || t.assignee || "Nobody", role: isRoleAssignee(t.assignee_info), tasks: [] };
    group.tasks.push(t);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(a.role) - Number(b.role) || a.label.localeCompare(b.label));
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
  /** The author's walkthrough of the change (ct-57527), hunks attached. */
  guide?: ChangeGuide;
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
  if (input.guide) body.change_guide = input.guide;
  if (sessionId) body.conversation_id = sessionId;
  return body;
}

export function handoffCommentText(input: HandoffInput): string {
  const lines = [`Handoff: ${input.status}`, "", input.evidence.trim()];
  if (input.files?.length) lines.push("", `Files: ${input.files.join(", ")}`);
  if (input.pr) lines.push("", `PR: ${input.pr}`);
  if (input.pages?.length) lines.push("", `Pages: ${input.pages.map((slug) => `/a/${slug}`).join(", ")}`);
  if (input.guide) lines.push("", `Guide: ${input.guide.steps.length} step${input.guide.steps.length === 1 ? "" : "s"}, on the task's evidence`);
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
