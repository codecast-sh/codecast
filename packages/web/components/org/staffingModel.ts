// The staffing pane's arithmetic (docs/architecture/org-staffing.md S5), pure
// so the tests pin it without a DOM: which mode the pane is in, how far a
// proposal is decided, the one line a change reads as, the company's flags
// with the node each one points at, span of control per person, and the roles
// that are bottlenecks. The pane renders these; it computes nothing itself.
import { PERSON_SPAN } from "@codecast/shared/contracts/orgCapacity";
import { ORG_SYNC_KINDS, PLAN_STATUS_CHANGES, PROJECT_STATUS_CHANGES, TASK_STATUS_CHANGES, describeTenure, editedOrgChange, isOrgChangeDecidable, orderOrgChanges, type OrgTenureSpec } from "@codecast/shared/contracts/orgProposal";
import { avatarOf } from "@codecast/shared/contracts/orgAvatars";
import type { OrgParentRef, OrgRole, OrgTree } from "./orgTypes";
import { parentNodeId, resolveOrgParentRef } from "./orgLayout";
import { CHANGE_KIND_META, kindLabel } from "./orgMeta";
import type { OrgCreateRoleInput } from "../../store/orgSlice";
import type { HireRoleInitial, HireRoleTouched } from "./HireRoleDialog";
import {
  CHIEF_OF_STAFF_HANDLE,
  type HealthFlag,
  type OrgChange,
  type OrgChangeStatus,
  type OrgHealth,
  type OrgProposalAuthor,
  type OrgProposalChange,
  type OrgProposalListRow,
  type OrgProposalRow,
} from "./orgStaffingTypes";

// ---------------------------------------------------------------- mode

export type StaffingMode = "proposal" | "health" | "no_chief";

/** The chief of staff, when hired: a live role with the reserved handle. */
export function findChiefOfStaff(tree: OrgTree | null): OrgRole | null {
  return tree?.roles.find((r) => r.handle === CHIEF_OF_STAFF_HANDLE && r.status !== "retired") ?? null;
}

/** Open proposals, newest first. */
export function openProposals(rows: OrgProposalRow[]): OrgProposalRow[] {
  return rows.filter((p) => p.status === "open").sort((a, b) => b.created_at - a.created_at);
}

/** What the pane shows (S5): a proposal when one is open, else the health
 *  summary, else, with no chief of staff at all, the two hire buttons. */
export function staffingMode(tree: OrgTree | null, proposal: OrgProposalRow | null): StaffingMode {
  if (proposal) return "proposal";
  return findChiefOfStaff(tree) ? "health" : "no_chief";
}

// ---------------------------------------------------------------- a review in flight

/** "Propose an org now", as the prefs bag keeps it (ClientUI.org_review_run). */
export type OrgReviewRun = { since: number; session_id: string | null; workspace: string };

/** A review that produced nothing gives the buttons back after this long. */
export const REVIEW_TTL_MS = 15 * 60_000;
/** A fresh session reads as idle for a moment before its first turn starts. */
export const REVIEW_START_GRACE_MS = 2 * 60_000;

/**
 * What the page says about the review it started:
 *   reviewing  the run is young, no proposal has landed, the session is not known to have stopped
 *   ended      the review session finished its turn, or was closed, and posted nothing
 *   none       no run for this workspace, a proposal landed since, or the run aged out
 * A proposal of ANY status counts as landed: one that was later withdrawn must
 * not flip the page back to "reviewing".
 */
export function reviewRunState(
  run: OrgReviewRun | null | undefined,
  now: number,
  workspace: string | null,
  proposals: Pick<OrgProposalRow, "created_at">[],
  session: { is_idle?: boolean; status?: string } | null | undefined,
): "reviewing" | "ended" | "none" {
  if (!run || !workspace || run.workspace !== workspace) return "none";
  if (now - run.since >= REVIEW_TTL_MS) return "none";
  if (proposals.some((p) => p.created_at >= run.since)) return "none";
  const stopped = !!session && (session.status === "completed" || session.is_idle === true);
  return stopped && now - run.since >= REVIEW_START_GRACE_MS ? "ended" : "reviewing";
}

// ---------------------------------------------------------------- progress

/** Still open to a verdict (S4): proposed, or failed and retryable. The one
 *  set the server's decide and acceptAll read, so the action rows, the
 *  counts, the ghost strip and the journal never disagree with it. */
export const isDecidable = isOrgChangeDecidable;

export type ProposalProgress = {
  decided: number; total: number; remaining: number; applied: number; skipped: number; failed: number;
  /** True while the numbers come from the list row's counts because the
   *  change rows have not landed yet (the pane says so instead of "0 of 0"). */
  fromCounts: boolean;
};

/** "N of M decided": a change is decided once it is no longer decidable
 *  (accepted, applied or skipped); a failed one is still to decide, as the
 *  server sees it. Before the change rows land, the list row's counts stand
 *  in: its `decided` is "not proposed", so the failed ones come back out. */
export function proposalProgress(p: Pick<OrgProposalRow, "changes" | "counts">): ProposalProgress {
  if (p.changes.length === 0 && p.counts) {
    const { total, applied, failed, skipped } = p.counts;
    const decided = Math.max(0, p.counts.decided - failed);
    return { decided, total, remaining: total - decided, applied, skipped, failed, fromCounts: true };
  }
  // A change the author removed (S18) is no longer anyone's to decide: it
  // leaves the count the way it left the ask.
  const live = p.changes.filter((c) => c.status !== "removed");
  const total = live.length;
  let decided = 0, applied = 0, skipped = 0, failed = 0;
  for (const c of live) {
    if (!isDecidable(c.status)) decided += 1;
    if (c.status === "applied") applied += 1;
    if (c.status === "skipped") skipped += 1;
    if (c.status === "failed") failed += 1;
  }
  return { decided, total, remaining: total - decided, applied, skipped, failed, fromCounts: false };
}

/** The changes still waiting on a verdict, in apply order. */
export function remainingChanges(p: Pick<OrgProposalRow, "changes">): OrgProposalChange[] {
  return orderChanges(p.changes.filter((c) => isDecidable(c.status)));
}

/** Changes in the order accept all applies them (S4), seq inside a kind. */
export function orderChanges(changes: OrgProposalChange[]): OrgProposalChange[] {
  return orderOrgChanges([...changes].sort((a, b) => a.seq - b.seq), (c) => c.change);
}

export type ChangeGroup = {
  /** A change kind, or "sync" for the records group (S9). */
  kind: OrgChange["kind"] | "sync";
  label: string;
  changes: OrgProposalChange[];
  /** The records group: the header says how many records it brings in line. */
  sync: boolean;
};

/** A plan, task or project status change (S9): a record the evidence says is
 *  already finished, not a staffing change. */
export function isSyncChange(change: OrgChange): boolean {
  return (ORG_SYNC_KINDS as readonly string[]).includes(change.kind);
}

/** The evidence line a sync change carries: what says the record is done.
 *  The analyzer writes it as the change's `reason`; the pane shows it under
 *  the line even when the row is not selected. Null for every other kind. */
export function syncEvidence(change: OrgChange): string | null {
  if (change.kind === "plan_status" || change.kind === "task_status" || change.kind === "project_status") return change.reason?.trim() || null;
  return null;
}

/** How many records a list of changes brings in line: one per distinct
 *  plan, task or project named, whatever the verdicts so far. */
export function recordsInLine(changes: OrgProposalChange[]): number {
  const refs = new Set<string>();
  for (const c of changes) {
    const ch = c.change;
    if (ch.kind === "plan_status") refs.add(`plan:${ch.plan}`);
    else if (ch.kind === "task_status") refs.add(`task:${ch.task}`);
    else if (ch.kind === "project_status") refs.add(`project:${ch.project}`);
  }
  return refs.size;
}

export const SYNC_GROUP_LABEL = "Records to bring up to date";

/** A records group over this many changes renders as one card (count by
 *  kind, the most consequential lines, the evidence summary, Accept group and
 *  Review each) instead of a wall of rows: the analyzer's first real review
 *  brought 111 records, readable only through accept all. */
export const SYNC_CARD_THRESHOLD = 8;

/** The record a sync change names ("plan:pl-61"), or null for any other kind. */
export function changeRecordRef(change: OrgChange): string | null {
  if (change.kind === "plan_status") return `plan:${change.plan}`;
  if (change.kind === "task_status") return `task:${change.task}`;
  if (change.kind === "project_status") return `project:${change.project}`;
  return null;
}

/** The tasks a plan status change closes along with the plan, when the
 *  analyzer put them on the change (`tasks`: refs). The apply cascade lands
 *  them in one accept, so the pane shows them under the plan row instead of
 *  as rows of their own. Read loosely: the contract field is arriving. */
export function planCarriedTasks(change: OrgChange): string[] {
  if (change.kind !== "plan_status") return [];
  const tasks = (change as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? tasks.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
}

const RECORD_WORD: Record<"plan_status" | "task_status" | "project_status", [string, string]> = {
  task_status: ["task", "tasks"],
  plan_status: ["plan", "plans"],
  project_status: ["project", "projects"],
};

/** The evidence a record change rests on, in one of a few words, so a
 *  hundred reasons sum to three counts. Ordered: the first pattern that
 *  matches names the bucket. */
const EVIDENCE_BUCKETS: [RegExp, string][] = [
  [/\bcommits? [0-9a-f]{6,}|\bcommits? (landed|on main)|\bon main\b|\bmerged\b|\bshipped\b|\blanded\b/i, "commits landed"],
  [/finished plan|plan (already )?(marked )?done|plan is done|its plan .* done/i, "under a finished plan"],
  [/session (is |was )?done|sessions? (ended|declared|finished)|handoff|declared done/i, "its session ended"],
  [/every task closed|all (its )?tasks (are )?(closed|done)|\d+ of \d+ done/i, "every task closed"],
  [/no session|no activity|nobody touched|untouched|no commit|idle|no wake/i, "no activity"],
];

export function evidenceBucket(reason: string | undefined): string {
  const text = reason ?? "";
  for (const [re, label] of EVIDENCE_BUCKETS) if (re.test(text)) return label;
  return "other evidence";
}

export type SyncGroupSummary = {
  /** Every record change in the group, nested tasks included. */
  total: number;
  /** Still to decide, nested tasks included. */
  remaining: number;
  /** Counts by record kind, largest first: "103 tasks, 8 plans". */
  byKind: { kind: "plan_status" | "task_status" | "project_status"; count: number; word: string }[];
  countLine: string;
  /** The most consequential changes, up to three: projects before plans
   *  before tasks, a plan that carries tasks before one that does not, then
   *  the biggest number its reason cites. */
  top: OrgProposalChange[];
  /** The evidence the reasons rest on, as counts, largest first. */
  evidence: { label: string; count: number }[];
  /** Task changes filed under the plan change that closes them, by the plan
   *  change's id; `rows` is the group with those tasks taken out. */
  nested: Record<string, OrgProposalChange[]>;
  rows: OrgProposalChange[];
};

const KIND_RANK = { project_status: 0, plan_status: 1, task_status: 2 } as const;

export function syncGroupSummary(changes: OrgProposalChange[]): SyncGroupSummary {
  const sync = changes.filter((c) => isSyncChange(c.change));
  const nested: Record<string, OrgProposalChange[]> = {};
  const nestedIds = new Set<string>();
  for (const c of sync) {
    const carried = planCarriedTasks(c.change);
    if (carried.length === 0) continue;
    const refs = new Set(carried.map((t) => `task:${t}`));
    const under = sync.filter((t) => t.change.kind === "task_status" && refs.has(changeRecordRef(t.change)!) && !nestedIds.has(t._id));
    if (under.length === 0) continue;
    nested[c._id] = under;
    for (const t of under) nestedIds.add(t._id);
  }
  const rows = sync.filter((c) => !nestedIds.has(c._id));
  const counts = new Map<"plan_status" | "task_status" | "project_status", number>();
  for (const c of sync) counts.set(c.change.kind as any, (counts.get(c.change.kind as any) ?? 0) + 1);
  const byKind = [...counts.entries()].map(([kind, count]) => ({ kind, count, word: RECORD_WORD[kind][count === 1 ? 0 : 1] })).sort((a, b) => b.count - a.count);
  const biggestNumber = (c: OrgProposalChange) => Math.max(0, ...((syncEvidence(c.change) ?? "").match(/\d+/g) ?? []).map(Number));
  const score = (c: OrgProposalChange) => KIND_RANK[c.change.kind as keyof typeof KIND_RANK] * 1_000_000 - (nested[c._id]?.length ?? 0) * 1_000 - Math.min(999, biggestNumber(c));
  const top = [...rows].sort((a, b) => score(a) - score(b) || a.seq - b.seq).slice(0, 3);
  const buckets = new Map<string, number>();
  for (const c of sync) { const b = evidenceBucket(syncEvidence(c.change) ?? undefined); buckets.set(b, (buckets.get(b) ?? 0) + 1); }
  const evidence = [...buckets.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  return {
    total: sync.length,
    remaining: sync.filter((c) => isDecidable(c.status)).length,
    byKind,
    countLine: byKind.map((k) => `${k.count} ${k.word}`).join(", "),
    top,
    evidence,
    nested,
    rows,
  };
}

/** The change list grouped in apply order, empty kinds dropped. The three
 *  record kinds (S9) rank first and share one group, "Records to bring up to date";
 *  every other kind is its own group. */
export function groupChanges(changes: OrgProposalChange[]): ChangeGroup[] {
  const ordered = orderChanges(changes);
  const out: ChangeGroup[] = [];
  for (const c of ordered) {
    const sync = isSyncChange(c.change);
    const kind: ChangeGroup["kind"] = sync ? "sync" : c.change.kind;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.changes.push(c);
    else out.push({ kind, label: sync ? SYNC_GROUP_LABEL : kindLabel(c.change.kind), changes: [c], sync });
  }
  return out;
}

/** The group header per kind: orgMeta's table, one place for the words. */
export const KIND_LABEL: Record<OrgChange["kind"], string> = Object.fromEntries(
  (Object.keys(CHANGE_KIND_META) as OrgChange["kind"][]).map((k) => [k, CHANGE_KIND_META[k].label]),
) as Record<OrgChange["kind"], string>;

// ---------------------------------------------------------------- one line per change

/** The one line a change reads as in the list: orgMeta's, shared with the ghost chips. */
export { changeLine, kindLabel, kindDescription, CHANGE_KIND_META, SEVERITY_COLOR } from "./orgMeta";

/** The handle a change acts on, when it names one. */
export function changeHandle(change: OrgChange): string | null {
  return "handle" in change ? change.handle : null;
}

/** Every role handle a change touches: its subject, and the parent a role or
 *  move names ("@growth"; "me" and a person's name are not roles). */
export function changeHandles(change: OrgChange): string[] {
  const out: string[] = [];
  const subject = changeHandle(change);
  if (subject) out.push(subject);
  if ("reports_to" in change && typeof change.reports_to === "string" && change.reports_to.startsWith("@")) out.push(change.reports_to.slice(1));
  if (change.kind === "project_meta" && change.owner?.startsWith("@")) out.push(change.owner.slice(1));
  return out;
}

export const CHANGE_STATUS_META: Record<OrgChangeStatus, { label: string; color: string }> = {
  proposed: { label: "proposed", color: "var(--sol-violet)" },
  accepted: { label: "accepted", color: "var(--sol-cyan)" },
  applied: { label: "applied", color: "var(--sol-green)" },
  skipped: { label: "skipped", color: "var(--sol-text-dim)" },
  failed: { label: "failed", color: "var(--sol-red)" },
  removed: { label: "removed", color: "var(--sol-text-dim)" },
};

/** The layout node a change focuses when its subject already exists on the
 *  chart. A change whose subject is still a ghost has none: the page focuses
 *  the ghost through orgFocusChangeId instead. */
export function changeNodeId(change: OrgChange, tree: OrgTree | null): string | null {
  const handle = changeHandle(change);
  if (!handle || !tree) return null;
  const role = tree.roles.find((r) => r.handle === handle && r.status !== "retired");
  return role ? parentNodeId({ kind: "role", role_id: role._id }) : null;
}

// ---------------------------------------------------------------- health

export type FlagSubject =
  | { kind: "role"; role_id: string; handle: string; nodeId: string }
  | { kind: "person"; user_id: string; name: string; nodeId: string }
  | { kind: "company" };

export type HealthFlagRow = { id: string; flag: HealthFlag; subject: FlagSubject };

const SEVERITY_RANK = { blocker: 0, warn: 1, info: 2 } as const;

/** Every flag org.health raised, worst first, each with the node it points at. */
export function collectHealthFlags(health: OrgHealth | null, tree: OrgTree | null): HealthFlagRow[] {
  if (!health) return [];
  const out: HealthFlagRow[] = [];
  for (const r of health.roles) {
    for (const [i, flag] of r.flags.entries()) out.push({ id: `r:${r.role_id}:${i}`, flag, subject: { kind: "role", role_id: r.role_id, handle: r.handle, nodeId: parentNodeId({ kind: "role", role_id: r.role_id }) } });
  }
  for (const p of health.people) {
    const name = tree?.people.find((x) => x.user_id === p.user_id)?.name ?? "person";
    for (const [i, flag] of p.flags.entries()) out.push({ id: `p:${p.user_id}:${i}`, flag, subject: { kind: "person", user_id: p.user_id, name, nodeId: parentNodeId({ kind: "user", user_id: p.user_id }) } });
  }
  for (const [i, flag] of health.company.flags.entries()) out.push({ id: `c:${i}`, flag, subject: { kind: "company" } });
  return out.sort((a, b) => SEVERITY_RANK[a.flag.severity] - SEVERITY_RANK[b.flag.severity]);
}

/** In proposal mode the pane's job is deciding changes, so of the company's
 *  flags only the ones a change addresses show: role flags on a handle some
 *  change touches. The full list stays one click away. */
export function relatedFlags(flags: HealthFlagRow[], changes: OrgProposalChange[]): HealthFlagRow[] {
  const handles = new Set(changes.flatMap((c) => changeHandles(c.change)));
  if (handles.size === 0) return [];
  return flags.filter((r) => r.subject.kind === "role" && handles.has(r.subject.handle));
}

export type SpanRow = { user_id: string; name: string; nodeId: string; direct_roles: number; limit: number; wide: boolean };

/** Span of control per person: direct roles against the model's limit. Reads
 *  the tree when health has no row for a person, so the summary is complete. */
export function spanOfControl(health: OrgHealth | null, tree: OrgTree | null): SpanRow[] {
  if (!tree) return [];
  const limit = PERSON_SPAN.direct_roles.value;
  return tree.people.map((p) => {
    const fromHealth = health?.people.find((h) => h.user_id === p.user_id)?.direct_roles;
    const direct = fromHealth ?? tree.roles.filter((r) => r.status !== "retired" && r.reports_to.kind === "user" && r.reports_to.user_id === p.user_id).length;
    return { user_id: p.user_id, name: p.name, nodeId: parentNodeId({ kind: "user", user_id: p.user_id }), direct_roles: direct, limit, wide: direct > limit };
  }).sort((a, b) => b.direct_roles - a.direct_roles);
}

export type BottleneckRow = { role_id: string; handle: string; nodeId: string; worst: HealthFlag["severity"]; flags: HealthFlag[] };

/** Roles carrying a warn or blocker flag, worst first. */
export function bottleneckRoles(health: OrgHealth | null): BottleneckRow[] {
  if (!health) return [];
  const out: BottleneckRow[] = [];
  for (const r of health.roles) {
    const flags = r.flags.filter((f) => f.severity !== "info");
    if (flags.length === 0) continue;
    const worst = flags.some((f) => f.severity === "blocker") ? "blocker" : "warn";
    out.push({ role_id: r.role_id, handle: r.handle, nodeId: parentNodeId({ kind: "role", role_id: r.role_id }), worst, flags });
  }
  return out.sort((a, b) => SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] || b.flags.length - a.flags.length);
}

/** A short label for a flag code, for badges. */
/** Each finding in the reader's words (S17): what the review saw, not the
 *  code's name for it. The flag's own detail sentence follows it. */
export const FLAG_LABEL: Record<HealthFlag["code"], string> = {
  overloaded: "more reaching it than it can handle",
  bypassed: "worked around",
  wide_span: "too many reporting to one person",
  idle: "nothing moved for a while",
  slow_to_recommend: "slow to answer",
  review_stall: "a review stuck waiting",
  cap_hit: "daily limit reached",
  unowned: "no owner",
  no_charter: "no charter written",
  chatter: "talks more than it delivers",
  unfiled_plan: "plan not under a project",
  program_ended: "its program ended",
  wide_ledger: "too much open at once",
  stale_plan: "plan record behind",
  stale_task: "task record behind",
  stale_project: "project record behind",
};

/** The `?proposal=` value a URL carries: "op-N", else null. */
export function proposalParam(search: string | null | undefined): string | null {
  if (!search) return null;
  try {
    const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("proposal");
    return v && /^op-\d+$/i.test(v) ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The proposal a URL asked for, by short id, else the newest open one. A
 *  named proposal that is not among the rows is null, never another
 *  proposal: the link line (resolveProposalLink) says where it is instead. */
export function pickProposal(rows: OrgProposalRow[], shortId: string | null): OrgProposalRow | null {
  if (shortId) return rows.find((p) => p.short_id === shortId) ?? null;
  return openProposals(rows)[0] ?? null;
}

// ---------------------------------------------------------------- tenure (S10)

/** A role change's tenure, edits laid over: standing, a program with its
 *  end, or null when the proposal left it unsaid. */
export function changeTenure(c: Pick<OrgProposalChange, "change" | "edits">): OrgTenureSpec | null {
  const ch = editedOrgChange(c.change, c.edits);
  return ch.kind === "role" ? ch.tenure ?? null : null;
}

/** The tenure as one short line ("standing", "program · ends with pl-3, then
 *  retire"), the plan or project named when the tree knows it. */
export function tenureLine(t: OrgTenureSpec | null | undefined, tree?: OrgTree | null): string {
  if (!t) return "";
  if (t.kind === "standing") return describeTenure(t);
  const e = t.ends as { plan?: string; project?: string; date?: number };
  const names: { plan?: string; project?: string } = {};
  if (e.plan && tree) names.plan = tree.roles.flatMap((r) => r.scope_names.plans).find((p) => p.id === e.plan || p.short_id === e.plan)?.short_id;
  if (e.project && tree) names.project = tree.roles.flatMap((r) => r.scope_names.projects).find((p) => p.id === e.project || p.short_id === e.project || p.title === e.project)?.title;
  return describeTenure(t, names);
}

// ---------------------------------------------------------------- inline edit

export type ChangeField = { key: string; label: string; kind: "text" | "number" | "list" | "select"; value: string; options?: readonly string[] };

/** The closed set a field picks from, when it has one: a record's status (S9). */
function fieldOptions(kind: OrgChange["kind"], key: string): readonly string[] | undefined {
  if (key !== "status") return undefined;
  if (kind === "plan_status") return PLAN_STATUS_CHANGES;
  if (kind === "task_status") return TASK_STATUS_CHANGES;
  if (kind === "project_status") return PROJECT_STATUS_CHANGES;
  return undefined;
}

/** The editable fields of a change, flattened one level ("caps.tokens_per_day")
 *  so the inline form (S5: Edit on anything but a role) is one input per field.
 *  `kind` is not editable; a change stays what it is. */
export function changeFields(change: OrgChange): ChangeField[] {
  const out: ChangeField[] = [];
  const push = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) out.push({ key, label: key.replace(/[._]/g, " "), kind: "list", value: v.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(", ") });
    else if (typeof v === "number") out.push({ key, label: key.replace(/[._]/g, " "), kind: "number", value: String(v) });
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) push(`${key}.${k}`, x);
    else {
      const options = fieldOptions(change.kind, key);
      out.push({ key, label: key === "reason" ? "evidence" : key.replace(/[._]/g, " "), kind: options ? "select" : "text", value: String(v), ...(options ? { options } : {}) });
    }
  };
  for (const [k, v] of Object.entries(change)) if (k !== "kind") push(k, v);
  return out;
}

/** The edits a form produced, as the nested object `decide` takes: only the
 *  fields whose text changed, parsed back to their kind. Empty when nothing did. */
export function changeEdits(change: OrgChange, fields: ChangeField[]): Record<string, unknown> {
  const original = changeFields(change);
  const edits: Record<string, unknown> = {};
  for (const f of fields) {
    const was = original.find((o) => o.key === f.key);
    if (was && was.value === f.value) continue;
    const value = f.kind === "number" ? Number(f.value) : f.kind === "list" ? f.value.split(",").map((s) => s.trim()).filter(Boolean) : f.value;
    if (f.kind === "number" && Number.isNaN(value)) continue;
    const path = f.key.split(".");
    let cur: Record<string, unknown> = edits;
    for (const p of path.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
    cur[path[path.length - 1]] = value;
  }
  return edits;
}

/** The `?compose=` text a URL carries for the chief of staff's composer (a
 *  charter empty state links here with "draft a charter for X"), else null. */
export function composeParam(search: string | null | undefined): string | null {
  if (!search) return null;
  try {
    const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("compose");
    const text = v?.trim() ?? "";
    return text ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- a link into another workspace

export type OrgWorkspaceRef = { kind: "team" | "user"; id: string };

/** Which workspace a proposal row belongs to (S4: team_id or scope_user_id). */
export function proposalWorkspace(p: Pick<OrgProposalRow, "team_id" | "scope_user_id">): OrgWorkspaceRef | null {
  if (p.team_id) return { kind: "team", id: p.team_id };
  if (p.scope_user_id) return { kind: "user", id: p.scope_user_id };
  return null;
}

export function sameWorkspace(a: OrgWorkspaceRef | null | undefined, b: OrgWorkspaceRef | null | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/**
 * The rows an orgProposals.list answer is authoritative for: that
 * workspace's, and nothing else. The list feeder prunes in-scope rows the
 * answer no longer carries (a withdrawn row deleted server side, a row a
 * tab injected by hand that the persisted cache then kept: the "Ghost
 * proof" proposal of 2026-09-15), while rows of other workspaces and the
 * one a foreign link fetched survive. A team's list is keyed by team_id; the
 * personal list holds only the viewer's rows, so "no team" is its scope.
 */
export function proposalListScope(teamId: string | undefined): (row: Pick<OrgProposalListRow, "team_id">) => boolean {
  return teamId ? (row) => row.team_id === teamId : (row) => !row.team_id;
}

export type ProposalLinkState =
  /** No link, or the linked proposal is in the active workspace. */
  | { kind: "open" }
  /** The linked proposal was read and lives in another workspace. */
  | { kind: "foreign"; shortId: string; row: OrgProposalRow; workspace: OrgWorkspaceRef }
  /** The server answered and there is no such proposal the viewer can read. */
  | { kind: "unreadable"; shortId: string }
  /** The lookup has not answered yet. */
  | { kind: "loading"; shortId: string };

/**
 * A link carries op-N alone (the queue card, `cast org propose`, the summary
 * page), so it may name a proposal outside the active workspace. The list
 * feeder only fills the active workspace's rows; the get feeder fills the
 * linked one whatever its workspace, so a row that exists but sits elsewhere
 * is a foreign link, and a lookup that answered with nothing is unreadable.
 */
export function resolveProposalLink(
  shortId: string | null,
  rows: OrgProposalRow[],
  active: OrgWorkspaceRef | null,
  lookup: { ready: boolean; missing: boolean },
): ProposalLinkState {
  if (!shortId) return { kind: "open" };
  const row = rows.find((p) => p.short_id === shortId);
  if (row) {
    const ws = proposalWorkspace(row);
    if (!active || !ws || sameWorkspace(ws, active)) return { kind: "open" };
    return { kind: "foreign", shortId, row, workspace: ws };
  }
  if (lookup.ready && lookup.missing) return { kind: "unreadable", shortId };
  return { kind: "loading", shortId };
}

/** The DEV preview paints fixtures only while `?preview=1` is in the live
 *  URL. Read per render, never once at module load: an in-app navigation
 *  that drops the flag must drop the fixtures with it. */
export function orgPreviewEnabled(search: string | null | undefined, dev: boolean): boolean {
  if (!dev || !search) return false;
  try {
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("preview") === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the hire dialog as an edit form

/**
 * A parent reference as a proposal writes one: "me" for the deciding person,
 * "@handle" for a role, else the row's id (the apply core resolves a member
 * or a role by id too). The inverse of orgLayout.resolveOrgParentRef.
 */
export function orgParentRefAsProposal(tree: OrgTree, ref: OrgParentRef | null | undefined, meId: string): string | undefined {
  if (!ref) return undefined;
  if (ref.kind === "user") return ref.user_id === meId ? "me" : ref.user_id;
  const role = tree.roles.find((r) => r._id === ref.role_id);
  return role ? `@${role.handle}` : ref.role_id;
}

/**
 * "Accept with edits" on a role change (S5): the hire dialog's output in the
 * proposal contract's shape. The dialog speaks in ids and parent refs
 * (`scope: { project_ids, plan_ids }`, `reports_to: OrgParentRef`); the
 * contract wants refs and a string (`scope: { projects, plans }`,
 * `reports_to: "@handle" | "me" | id`), and the server lays the edits over
 * the change as they are. Sending the dialog's shape raw left the role with
 * no scope and a reports_to the apply core could not read.
 */
export function roleChangeEdits(input: Pick<OrgCreateRoleInput, "name" | "handle" | "charter" | "caps" | "scope" | "reports_to"> & { tenure?: OrgTenureSpec; avatar?: string; touched?: HireRoleTouched }, tree: OrgTree, meId: string): Record<string, unknown> {
  // Scope and parent ride along only when the person changed them: an
  // untouched form must not overwrite a ref it could not resolve, or a
  // parent the same proposal creates, with what it happened to display.
  const touched = input.touched ?? { scope: true, reports_to: true };
  const reports_to = touched.reports_to ? orgParentRefAsProposal(tree, input.reports_to, meId) : undefined;
  return {
    name: input.name,
    handle: input.handle,
    ...(input.charter ? { charter: input.charter } : {}),
    ...(input.caps ? { caps: { ...input.caps } } : {}),
    // Tenure and avatar (S10, S13) ride as the form hands them.
    ...(input.tenure ? { tenure: input.tenure } : {}),
    ...(input.avatar ? { avatar: input.avatar } : {}),
    ...(touched.scope ? { scope: { projects: [...(input.scope?.project_ids ?? [])], plans: [...(input.scope?.plan_ids ?? [])] } } : {}),
    ...(reports_to ? { reports_to } : {}),
  };
}

/** The dialog's prefill for a role change, edits included, with the parent
 *  resolved against the tree. Undefined for any other kind. */
export function roleChangeInitial(c: OrgProposalChange, tree: OrgTree): (HireRoleInitial & { tenure?: OrgTenureSpec; avatar?: string }) | undefined {
  const ch = editedOrgChange(c.change, c.edits);
  if (ch.kind !== "role") return undefined;
  return {
    name: ch.name,
    handle: ch.handle.replace(/^@/, ""),
    ...(ch.charter ? { charter: ch.charter } : {}),
    ...(ch.caps ? { caps: ch.caps } : {}),
    ...(ch.scope ? { scope: ch.scope } : {}),
    ...(ch.tenure ? { tenure: ch.tenure } : {}),
    ...(ch.avatar ? { avatar: ch.avatar } : {}),
    reports_to: resolveOrgParentRef(tree, ch.reports_to),
  };
}

// ---------------------------------------------------------------- where a proposal came from (S15)

/** What the author pill draws. `href` opens a role's scope page; a session
 *  opens through the caller's session navigation (`sessionId`), never a bare
 *  link, so the usual stage and pane rules apply. */
export type ProposalAuthorView =
  | { kind: "session"; sessionId: string; title: string; shortId: string | null }
  | { kind: "role"; roleId: string; name: string; handle: string | null; avatar: string; href: string | null }
  | { kind: "user"; name: string };

/**
 * The author, named. The server's enrichment wins when present; else the
 * store rows the caller could find (the session row by id, the org tree's
 * role row); else the bare id, so a pill always reads as something and the
 * click still lands.
 */
export function resolveProposalAuthor(
  author: OrgProposalAuthor,
  found: { session?: { title?: string | null; short_id?: string | null } | null; role?: Pick<OrgRole, "name" | "handle" | "short_id"> & { avatar?: string } | null; user?: { name?: string | null } | null },
): ProposalAuthorView {
  if (author.kind === "session") {
    const shortId = author.short_id ?? found.session?.short_id ?? null;
    const title = author.title ?? author.name ?? found.session?.title ?? (shortId ? "Session" : "a session");
    return { kind: "session", sessionId: author.id, title, shortId };
  }
  if (author.kind === "role") {
    const shortId = author.short_id ?? found.role?.short_id ?? null;
    const handle = author.handle ?? found.role?.handle ?? null;
    const name = author.name ?? found.role?.name ?? (handle ? `@${handle}` : "a role");
    return { kind: "role", roleId: author.id, name, handle, avatar: avatarOf({ avatar: author.avatar ?? found.role?.avatar, handle: handle ?? author.id }), href: shortId ? `/org/${shortId}` : null };
  }
  return { kind: "user", name: author.name ?? found.user?.name ?? "a person" };
}

/** The proposal a queue card or a decision page points at: its `?proposal=op-N`
 *  link is in the decision's context (orgProposals.create), else null. */
export function proposalRefInContext(md: string | null | undefined): string | null {
  const m = /\/org\?proposal=(op-\d+)/i.exec(md ?? "");
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------- the summary a person reads cold (S17)

/**
 * The analyzer's summary split three ways (S17): the ask, its first
 * paragraph, which the pane shows in front; the tail, every paragraph after
 * it (the analyzer's real runs put about 200 words in the ask and 900 in the
 * tail), which sits behind one control; and the one line that only carries
 * the evidence link ("Evidence, what could not be verified, findings and
 * escalations: https://…"), which becomes the Evidence control wherever it
 * sat. A summary with one paragraph has no tail.
 */
export function splitAsk(summaryMd: string | null | undefined): { ask: string; tail: string; evidenceHref: string | null } {
  const text = (summaryMd ?? "").trim();
  if (!text) return { ask: "", tail: "", evidenceHref: null };
  let evidenceHref: string | null = null;
  const kept = text.split("\n").filter((line) => {
    const m = line.match(/^\s*\**evidence\b[^\n]*?(https?:\/\/\S+)\**\s*$/i);
    if (m && !evidenceHref) { evidenceHref = m[1].replace(/[.,)*]+$/, ""); return false; }
    return true;
  });
  const paragraphs = kept.join("\n").split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
  return { ask: paragraphs[0] ?? "", tail: paragraphs.slice(1).join("\n\n"), evidenceHref };
}

export type BudgetCaps = { hands_per_day: number; wakes_per_day: number; tokens_per_day: number };
export type BudgetLine = { handle: string; name?: string; before: Partial<BudgetCaps> | null; after: Partial<BudgetCaps> | null; note: string };
export type BudgetArithmetic = {
  /** Active seats' daily limits summed, today. */
  today: BudgetCaps;
  /** The same sum if every remaining change is accepted as proposed. */
  after: BudgetCaps;
  /** Seats that count today (active, with a limit). */
  seats: number;
  /** Paused seats, which stay outside both totals. */
  paused: number;
  /** One line per change that moves the total. */
  lines: BudgetLine[];
};

const ZERO_CAPS: BudgetCaps = { hands_per_day: 0, wakes_per_day: 0, tokens_per_day: 0 };
const addCaps = (a: BudgetCaps, b: Partial<BudgetCaps> | undefined | null, sign = 1): BudgetCaps => ({
  hands_per_day: a.hands_per_day + sign * (b?.hands_per_day ?? 0),
  wakes_per_day: a.wakes_per_day + sign * (b?.wakes_per_day ?? 0),
  tokens_per_day: a.tokens_per_day + sign * (b?.tokens_per_day ?? 0),
});

/**
 * The budget arithmetic behind the pane's Budget control, computed from the
 * tree and the proposal rather than quoted from the analyzer's prose: today's
 * total across active seats, the total if every open change lands, and the
 * lines that move it (a new seat's limit, a changed limit, a retired seat).
 * Skipped and already applied rows are left out: applied ones are in the
 * tree already, skipped ones never will be.
 */
export function budgetArithmetic(tree: OrgTree | null, changes: OrgProposalChange[]): BudgetArithmetic {
  const roles = tree?.roles ?? [];
  const active = roles.filter((r) => r.status === "active");
  const paused = roles.filter((r) => r.status === "paused").length;
  let today = ZERO_CAPS;
  for (const r of active) today = addCaps(today, r.caps);
  const capsOf = (h: string) => active.find((r) => r.handle === h.replace(/^@/, ""))?.caps ?? null;
  const nameOf = (h: string) => roles.find((r) => r.handle === h.replace(/^@/, ""))?.name;
  let after = today;
  const lines: BudgetLine[] = [];
  for (const c of changes) {
    if (!isDecidable(c.status)) continue;
    const ch = editedOrgChange(c.change, c.edits);
    if (ch.kind === "role" && ch.caps) {
      after = addCaps(after, ch.caps);
      lines.push({ handle: ch.handle, name: ch.name, before: null, after: ch.caps, note: "new seat" });
    } else if (ch.kind === "budget") {
      const before = capsOf(ch.handle);
      const next = { ...(before ?? {}), ...ch.caps };
      after = addCaps(addCaps(after, before, -1), next);
      lines.push({ handle: ch.handle, name: nameOf(ch.handle), before, after: next, note: before ? "changed limit" : "limit on a seat this proposal adds" });
    } else if (ch.kind === "retire") {
      const before = capsOf(ch.handle);
      if (before) { after = addCaps(after, before, -1); lines.push({ handle: ch.handle, name: nameOf(ch.handle), before, after: null, note: "seat closed" }); }
    }
  }
  return { today, after, seats: active.filter((r) => r.caps).length, paused, lines };
}

/** "6 hands, 40 wakes, 400,000 tokens": the three limits in one line, in the
 *  order they always read. */
export function capsLine(caps: Partial<BudgetCaps> | null | undefined): string {
  if (!caps) return "no limit set";
  const parts: string[] = [];
  if (caps.hands_per_day !== undefined) parts.push(`${caps.hands_per_day} ${caps.hands_per_day === 1 ? "hand" : "hands"}`);
  if (caps.wakes_per_day !== undefined) parts.push(`${caps.wakes_per_day} ${caps.wakes_per_day === 1 ? "wake" : "wakes"}`);
  if (caps.tokens_per_day !== undefined) parts.push(`${caps.tokens_per_day.toLocaleString("en-US")} tokens`);
  return parts.join(", ") || "no limit set";
}

/** Whether this person has accepted a change on any proposal in view: the
 *  cold read intro (S17) is for someone who has not. The pref stamps the
 *  fact for good once they accept; this covers people who accepted before
 *  the pref existed. */
export function hasAcceptedBefore(proposals: Pick<OrgProposalRow, "changes">[], meId: string | null | undefined): boolean {
  if (!meId) return false;
  return proposals.some((p) => p.changes.some((c) => c.decided_by === meId && (c.status === "accepted" || c.status === "applied" || c.status === "failed")));
}
