// Field mapping and conflict policy for issue sync (S2, S3).
//
// Pure: no convex imports, no db, no fetch. Everything that decides WHAT a
// provider issue means for a task lives here so it can be unit tested against
// real webhook payloads, and so the inbound path (webhook, reconcile, import)
// and the outbound path share one vocabulary instead of two.
//
// The heart of it is `diffAgainstTask`: an inbound event whose mapped values
// already equal the task's is an empty diff, which is what makes the
// echo loop terminate (S3, S4.2).

export type IssueProvider = "linear" | "github";

/** A provider issue reduced to our vocabulary. Mirrors normalizedIssueValidator. */
export type NormalizedIssue = {
  provider: IssueProvider;
  id: string;
  identifier: string;
  url: string;
  number?: number;
  repo?: string;
  team_key?: string;
  team_id?: string;
  project_id?: string;
  title: string;
  /** Always a string: "" is a cleared body, so a clear syncs like any edit. */
  description?: string;
  /** One of the six task status categories. */
  status: string;
  state_name?: string;
  /** Our priority word. Absent means the provider has no priority (GitHub). */
  priority?: string;
  assignee_email?: string;
  assignee_login?: string;
  assignee_label?: string;
  labels: string[];
  remote_updated_at: number;
  remote_created_at?: number;
  actor?: string;
  deleted?: boolean;
};

export type NormalizedComment = {
  provider: IssueProvider;
  id: string;
  issue_id: string;
  body: string;
  author?: string;
  author_email?: string;
  author_login?: string;
  url?: string;
  created_at: number;
  updated_at?: number;
  deleted?: boolean;
};

/** The fields a provider issue can move on a task. Order is the diff order. */
export const SYNCED_TASK_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "assignee",
  "labels",
] as const;

export type SyncedTaskField = (typeof SYNCED_TASK_FIELDS)[number];

export type TaskDiff = {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
};

/* ---------------- Linear (S2) ---------------- */

/**
 * Linear state.type -> our category. A team state whose NAME reads like review
 * refines `started` into in_review — that is how Linear teams express the
 * review column, since Linear has no separate state type for it.
 */
export function linearStatusFor(stateType?: string, stateName?: string): string {
  switch (stateType) {
    case "triage":
    case "backlog":
      return "backlog";
    case "unstarted":
      return "open";
    case "started":
      return /review/i.test(stateName || "") ? "in_review" : "in_progress";
    case "completed":
      return "done";
    case "canceled":
    case "cancelled":
      return "dropped";
    default:
      return "open";
  }
}

const LINEAR_PRIORITY_WORDS = ["none", "urgent", "high", "medium", "low"];

export function linearPriorityWord(priority: unknown): string | undefined {
  if (typeof priority !== "number" || !Number.isInteger(priority)) return undefined;
  return LINEAR_PRIORITY_WORDS[priority];
}

/** Our priority word -> Linear's 0..4. Unknown words fall back to none. */
export function linearPriorityFor(priority: string | undefined): number {
  const idx = LINEAR_PRIORITY_WORDS.indexOf(String(priority ?? "none"));
  return idx >= 0 ? idx : 0;
}

function labelNames(raw: any): string[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.nodes) ? raw.nodes : [];
  const names: string[] = [];
  for (const l of list) {
    const name = typeof l === "string" ? l : l?.name;
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}

function ts(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * A Linear webhook `data` object or a GraphQL issue node -> NormalizedIssue.
 * Both carry the same field names, which is why one function covers the
 * webhook path and the pull path.
 */
export function normalizeLinearIssue(
  data: any,
  opts: { deleted?: boolean; actor?: string; now?: number } = {},
): NormalizedIssue {
  const now = opts.now ?? Date.now();
  const teamKey: string | undefined = data?.team?.key;
  const number: number | undefined = typeof data?.number === "number" ? data.number : undefined;
  const identifier: string =
    data?.identifier || (teamKey && number != null ? `${teamKey}-${number}` : String(data?.id ?? ""));
  const assignee = data?.assignee;
  return {
    provider: "linear",
    id: String(data?.id ?? ""),
    identifier,
    url: data?.url || "",
    number,
    team_key: teamKey,
    team_id: data?.team?.id,
    project_id: data?.project?.id,
    title: String(data?.title ?? ""),
    description: typeof data?.description === "string" ? data.description : "",
    status: linearStatusFor(data?.state?.type, data?.state?.name),
    state_name: data?.state?.name,
    priority: linearPriorityWord(data?.priority),
    assignee_email: assignee?.email,
    assignee_label: assignee?.name || assignee?.displayName || assignee?.email,
    labels: labelNames(data?.labels),
    remote_updated_at: ts(data?.updatedAt, now),
    remote_created_at: data?.createdAt ? ts(data.createdAt, now) : undefined,
    actor: opts.actor,
    deleted: opts.deleted || undefined,
  };
}

export function normalizeLinearComment(
  data: any,
  opts: { issue_id?: string; deleted?: boolean; now?: number } = {},
): NormalizedComment {
  const now = opts.now ?? Date.now();
  const user = data?.user;
  return {
    provider: "linear",
    id: String(data?.id ?? ""),
    issue_id: String(data?.issue?.id ?? data?.issueId ?? opts.issue_id ?? ""),
    body: String(data?.body ?? ""),
    author: user?.name || user?.displayName || user?.email,
    author_email: user?.email,
    url: data?.url,
    created_at: ts(data?.createdAt, now),
    updated_at: data?.updatedAt ? ts(data.updatedAt, now) : undefined,
    deleted: opts.deleted || undefined,
  };
}

/* ---------------- GitHub (S2) ---------------- */

/** GitHub has one closed state and a reason; not_planned is our dropped. */
export function githubStatusFor(state?: string, stateReason?: string | null): string {
  if (state === "closed") return stateReason === "not_planned" ? "dropped" : "done";
  return "open";
}

/** Our category -> the GitHub issue state write. */
export function githubStateFor(category: string): { state: string; state_reason?: string } {
  if (category === "done") return { state: "closed", state_reason: "completed" };
  if (category === "dropped") return { state: "closed", state_reason: "not_planned" };
  return { state: "open", state_reason: "reopened" };
}

export function normalizeGithubIssue(
  issue: any,
  repoFullName: string,
  opts: { deleted?: boolean; actor?: string; now?: number } = {},
): NormalizedIssue {
  const now = opts.now ?? Date.now();
  const assignee = issue?.assignees?.[0] ?? issue?.assignee ?? undefined;
  return {
    provider: "github",
    id: String(issue?.node_id ?? issue?.id ?? ""),
    identifier: `${repoFullName}#${issue?.number}`,
    url: issue?.html_url || "",
    number: typeof issue?.number === "number" ? issue.number : undefined,
    repo: repoFullName,
    title: String(issue?.title ?? ""),
    description: typeof issue?.body === "string" ? issue.body : "",
    status: githubStatusFor(issue?.state, issue?.state_reason),
    // GitHub has no priority field: leaving it absent means "never touch ours".
    priority: undefined,
    assignee_login: assignee?.login,
    assignee_label: assignee?.login,
    labels: labelNames(issue?.labels),
    remote_updated_at: ts(issue?.updated_at, now),
    remote_created_at: issue?.created_at ? ts(issue.created_at, now) : undefined,
    actor: opts.actor,
    deleted: opts.deleted || undefined,
  };
}

export function normalizeGithubComment(
  comment: any,
  issueId: string,
  opts: { deleted?: boolean; now?: number } = {},
): NormalizedComment {
  const now = opts.now ?? Date.now();
  return {
    provider: "github",
    id: String(comment?.node_id ?? comment?.id ?? ""),
    issue_id: issueId,
    body: String(comment?.body ?? ""),
    author: comment?.user?.login,
    author_login: comment?.user?.login,
    url: comment?.html_url,
    created_at: ts(comment?.created_at, now),
    updated_at: comment?.updated_at ? ts(comment.updated_at, now) : undefined,
    deleted: opts.deleted || undefined,
  };
}

/* ---------------- Conflict policy (S3) ---------------- */

function sameLabelSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = [...new Set(a ?? [])].sort();
  const right = [...new Set(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

export type DiffableTask = {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  external?: { field_ts?: Record<string, number> };
};

/**
 * The fields this inbound event may write, per S3.
 *
 * Two gates, both required. A field is in the diff only if the mapped provider
 * value DIFFERS from ours (equality is the echo guard that terminates the
 * loop), and only if the event is at least as new as our last local push of
 * that field (`field_ts`), so an event already in flight when we wrote cannot
 * clobber the write it crossed.
 *
 * `assignee` is resolved by the caller (mapping a provider user to one of ours
 * needs the db) and passed in; absent means "we could not map them", which is
 * not the same as "unassign" and so never lands in the diff.
 */
export function diffAgainstTask(
  task: DiffableTask,
  issue: NormalizedIssue,
  resolved: { assignee?: string } = {},
): TaskDiff {
  const fieldTs = task.external?.field_ts ?? {};
  const fresh = (field: SyncedTaskField) => issue.remote_updated_at >= (fieldTs[field] ?? 0);
  const out: TaskDiff = {};

  if (issue.title && issue.title !== task.title && fresh("title")) out.title = issue.title;

  if (
    issue.description !== undefined
    && issue.description !== (task.description ?? "")
    && fresh("description")
  ) {
    out.description = issue.description;
  }

  if (issue.status && issue.status !== task.status && fresh("status")) out.status = issue.status;

  if (issue.priority && issue.priority !== task.priority && fresh("priority")) {
    out.priority = issue.priority;
  }

  // Only a mapped provider user moves the assignee. An unmapped one is
  // recorded as external.assignee_label by the caller instead.
  if (resolved.assignee && resolved.assignee !== task.assignee && fresh("assignee")) {
    out.assignee = resolved.assignee;
  }

  if (!sameLabelSet(issue.labels, task.labels) && fresh("labels")) out.labels = issue.labels;

  return out;
}

/* ---------------- Reverse map for outbound (S5) ---------------- */

export type LinearWorkflowState = { id: string; name: string; type: string };

/**
 * The Linear workflow state to write for one of our categories.
 *
 * Runs the FORWARD map over the team's states and takes the first that lands
 * on the category, so the two directions can never disagree: a team state
 * named "In review" is in_review both ways. `statusName` is the team's custom
 * status name when the task carries one, and an exact name match wins over
 * position, which is what lets a team with two "started" states pick the right
 * one.
 */
export function linearStateFor(
  category: string,
  states: LinearWorkflowState[],
  statusName?: string,
): LinearWorkflowState | undefined {
  if (statusName) {
    const named = states.find((s) => s.name.toLowerCase() === statusName.toLowerCase());
    if (named) return named;
  }
  const mapped = states.find((s) => linearStatusFor(s.type, s.name) === category);
  if (mapped) return mapped;
  // in_review with no review-named state: any started state still beats nothing.
  if (category === "in_review") return states.find((s) => s.type === "started");
  if (category === "backlog") return states.find((s) => s.type === "triage" || s.type === "backlog");
  return undefined;
}
