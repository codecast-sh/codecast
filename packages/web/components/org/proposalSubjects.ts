// A proposal's changes as cards, one per subject (org-staffing.md S39): every
// change to one goal, one project, one role or one record reads as one plain
// sentence, a few fields with what was there before, and the reasons. Pure:
// no React, no store. The words come from the one translator
// (orgChangeWords: changeWords, subjectWords, fieldMoves); this file is the
// web adapter: which changes belong together, what each field read as before
// (the live record while a change waits, the stamp once applied, nothing for
// another workspace) and the faces drawn beside a value.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import type { OrgAppliedDiffRow } from "@codecast/shared/contracts/orgChange";
import { changeWords, fieldMoves, proposalTotals, recordTotalsWords, subjectWords, type ChangeField, type ChangeWordsCtx, type FieldRef, type FieldText } from "@codecast/shared/contracts/orgChangeWords";
import {
  andList, editedOrgChange, isOrgChangeDecidable, isOrgQuietChange, orgRecordGroups, quietChangeSentence, recordAct,
  type OrgAskNames, type OrgChange, type OrgChangeReply, type OrgChangeStatus, type OrgEvidenceLink, type OrgPriority, type OrgRecordGroup,
} from "@codecast/shared/contracts/orgProposal";
import { refMatches, refResolves, type OrgGhostOptions } from "./orgLayout";
import type { OrgProposalChange } from "./orgStaffingTypes";
import type { OrgParentRef, OrgRole, OrgTree } from "./orgTypes";
import { partyFace, proposalChangeRows, treeOrder, type ProposalTreeFace, type ProposalTreeRow } from "./proposalTree";
import { askNames } from "./staffingAsks";
import { orderChanges, planCarriedTasks, syncEvidence, syncGroupSummary } from "./staffingModel";
import { revisionWord } from "./staffingRevise";

// ---------------------------------------------------------------- types

export type SubjectKind = "goal" | "project" | "role" | "plan" | "task" | "projects" | "instance";
export type SubjectStatus = "proposed" | "accepted" | "applied" | "skipped" | "failed" | "mixed";

export type SubjectCard = {
  /** "goal:<id>", "project:<id>", "role:<handle>", "plan:<id or ref>", "task:<ref>", "projects:<change id>", "instance:<slug>". */
  key: string;
  kind: SubjectKind;
  proposal_id: string;
  /** The subject as the tree draws it. */
  face: ProposalTreeFace;
  /** The subject's name: the one bold run of the sentence. */
  title: string;
  /** This proposal creates the subject. */
  isNew: boolean;
  /** The goal this proposal sets as the purpose: its long fields are read in full. */
  purpose: boolean;
  /** A retirement, or a record being closed. */
  struck: boolean;
  /** Drawn changes in reading order: the change that creates the subject first, then by number. The first is the lead. */
  changes: OrgProposalChange[];
  /** Quiet changes on this subject (a limit, S23.2): decided with the card, never drawn. */
  riders: OrgProposalChange[];
  /** Task changes a plan change closes with it: named in a short list, decided with the card. */
  carried: OrgProposalChange[];
  /** Every member in apply order: what a verdict sends. */
  change_ids: string[];
  /** Drawn seqs, ascending. */
  seqs: number[];
  status: SubjectStatus;
  /** Members still waiting on a verdict (a failed one waits too). */
  waiting: number;
  /** One sentence, verb first, naming the subject, with its full stop. */
  sentence: string;
  /** Where `title` sits in `sentence`, for emphasis. */
  subjectSpan: [number, number] | null;
  /** The same sentence calling the subject "this goal", "this role". */
  sentenceThis: string;
  /** The fields, from the translator, each stamped with its change's seq. */
  rows: ChangeField[];
  /** A face beside a value, keyed `${seq}:${key}:${before|after}`. */
  faces: Record<string, ProposalTreeFace>;
  /** Each drawn change's reason, in reading order, repeats dropped. */
  reasons: string[];
  /** Row evidence, plus the plain strings a role or a goal change carries, repeats dropped. */
  evidence: OrgEvidenceLink[];
  /** "Under <parent goal>", "Reports to <parent>"; null when a row already says it or nothing is known. */
  sits: string | null;
  failed: { seq: number; note: string }[];
  /** The person's latest answer that still stands (S39). Null once the author amended the change after it. */
  reply: OrgChangeReply | null;
  /** What a change needs from, or gives to, another change of the proposal. */
  depends: string[];
  /** What the author's revise did (S18): the word, the note, and the fields it moved. */
  revisions: { seq: number; word: string; note: string; fields: ChangeField[] }[];
};

/** The live records a before is read from. Null for a proposal of another workspace. */
export type SubjectLive = {
  tree: OrgTree | null;
  goals: readonly InitiativeRow[];
  projects: readonly { _id: string; short_id?: string; title: string; status: string; priority?: OrgPriority; goal?: string; success_metrics?: string[]; non_goals?: string[]; risks?: string[]; owner_role_id?: string }[];
  plans: readonly { _id: string; short_id?: string; title: string; status: string; project_id?: string }[];
  /** Only the tasks the proposal names. */
  tasks: readonly { _id: string; short_id: string; title: string; status: string }[];
};

export type SubjectOptions = {
  viewerSession?: OrgGhostOptions["viewerSession"];
  /** Group only these seqs (an ask's). Every row still resolves against the whole proposal. */
  seqs?: ReadonlySet<number>;
};

/** One record of a group row, in the author's order. */
export type RecordRow = {
  seq: number;
  change: OrgProposalChange;
  sentence: string;
  subjectSpan: [number, number] | null;
  status: OrgChangeStatus;
  reason: string;
  /** The record is being closed (done, dropped, abandoned): drawn struck. */
  closed: boolean;
  failed?: string;
};

/** One collapsed row per orgRecordGroups entry: the title, the totals line, the rows behind it. */
export type RecordGroupCard = {
  key: string;
  group: OrgRecordGroup;
  title: string;
  kindWord: "project" | "plan" | null;
  totals: string;
  rows: RecordRow[];
  change_ids: string[];
  seqs: number[];
  status: SubjectStatus;
  waiting: number;
  failed: number;
  reply: OrgChangeReply | null;
};

// ---------------------------------------------------------------- words

const PURPOSE = "the purpose";
const bare = (handle: string) => handle.replace(/^@/, "").trim().toLowerCase();
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dedupe = <T,>(items: readonly T[], keyOf: (t: T) => string): T[] => { const seen = new Set<string>(); return items.filter((t) => { const k = keyOf(t); if (seen.has(k)) return false; seen.add(k); return true; }); };
const strings = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);

/** A value as the words a person reads (the field's data attribute). */
export const fieldText = (v: FieldText | null): string | undefined => (v ? v.text + (v.tail ?? "") : undefined);

// ---------------------------------------------------------------- keys and status

const HANDLE_KINDS = new Set(["role", "move", "retire", "scope", "budget", "trust", "routine", "adopt", "authority", "hire", "charter_edit"]);
const KIND_ORDER: SubjectKind[] = ["goal", "project", "role", "plan", "task", "projects", "instance"];
type NamedRow = { id: string; title: string; short_id?: string };

/**
 * The subject a change belongs to. Everything on one handle is one role, a
 * goal's shape and its projects are one goal, a project's fields and its
 * status one project. `row` is the change's tree row (null for a quiet
 * change, which draws none); `plans` resolves a plan ref to its live id so
 * `pl-12` and the plan's id name one subject.
 */
export function subjectKeyOf(row: Pick<ProposalTreeRow, "change_id" | "node"> | null, change: OrgChange, plans: readonly NamedRow[] = []): string {
  if (HANDLE_KINDS.has(change.kind)) return `role:${bare((change as { handle: string }).handle)}`;
  const plan = (ref: string) => `plan:${plans.find((p) => refMatches(ref, p))?.id ?? ref.trim().toLowerCase()}`;
  switch (change.kind) {
    case "initiative": case "initiative_projects": case "initiative_owner": case "initiative_shape":
      return `goal:${row?.node.id ?? ("initiative" in change ? change.initiative : change.title).trim().toLowerCase()}`;
    case "project_meta": case "project_status": return `project:${(row?.node.id ?? change.project).trim().toLowerCase()}`;
    case "plan_status": case "file": return plan(change.plan);
    case "task_status": return `task:${change.task.trim().toLowerCase()}`;
    case "upgrade": return `instance:${change.instance.trim().toLowerCase()}`;
    default: return `projects:${row?.change_id ?? ""}`;
  }
}

/** Where a set of changes stands as one: all alike reads as that status; any
 *  failure is a failure; accepted beside applied is still on its way in;
 *  anything else ended differently. */
export function subjectStatus(members: readonly Pick<OrgProposalChange, "status">[]): SubjectStatus {
  const seen = new Set(members.map((m) => m.status).filter((s) => s !== "removed"));
  if (seen.size === 0) return "proposed";
  if (seen.has("failed")) return "failed";
  if (seen.size === 1) return [...seen][0] as SubjectStatus;
  if (seen.size === 2 && seen.has("accepted") && seen.has("applied")) return "accepted";
  return "mixed";
}

const membersOf = (card: SubjectCard) => [...card.changes, ...card.carried, ...card.riders];

/** The person's answer on a change row while it still stands: an amend by
 *  the author (`revision.at` after `reply.at`) makes the row answerable again
 *  and retires the words. */
export function changeReply(change: Pick<OrgProposalChange, "reply" | "revision">): OrgChangeReply | null {
  const reply = change.reply;
  if (!reply) return null;
  return change.revision && change.revision.at >= reply.at ? null : reply;
}

/** The latest answer that still stands across a set of rows. */
const latestReply = (members: readonly OrgProposalChange[]): OrgChangeReply | null =>
  members.map(changeReply).filter((r): r is OrgChangeReply => !!r).sort((a, b) => b.at - a.at)[0] ?? null;

/** The card's status in words: "To decide", "2 to decide", "Noted" (a card
 *  the person wrote back on, still waiting on a revision), "Approved",
 *  "Rejected", "Failed", "1 of 2 approved, 1 failed". */
export function subjectStatusWords(card: SubjectCard): string {
  const members = membersOf(card);
  const n = (...statuses: OrgChangeStatus[]) => members.filter((m) => statuses.includes(m.status)).length;
  switch (card.status) {
    case "proposed": {
      if (card.reply?.verdict === "note") return "Noted";
      const shown = card.changes.length + card.carried.length || 1;
      return shown === 1 ? "To decide" : `${shown} to decide`;
    }
    case "accepted": case "applied": return "Approved";
    case "skipped": return "Rejected";
    case "failed": {
      const failed = n("failed"), approved = n("accepted", "applied");
      if (failed === members.length) return "Failed";
      return approved > 0 ? `${approved} of ${members.length} approved, ${failed} failed` : `${failed} of ${members.length} failed`;
    }
    case "mixed": {
      const approved = n("accepted", "applied");
      return approved > 0 ? `${approved} of ${members.length} approved` : `${n("skipped")} of ${members.length} rejected`;
    }
  }
}

/** The proposal's cards by where they stand: what a person counts down the list. */
export function subjectCounts(cards: readonly SubjectCard[]): { total: number; waiting: number; approved: number; rejected: number; failed: number } {
  const counts = { total: cards.length, waiting: 0, approved: 0, rejected: 0, failed: 0 };
  for (const card of cards) {
    if (card.status === "failed") counts.failed += 1;
    else if (card.waiting > 0) counts.waiting += 1;
    else if (card.status === "skipped") counts.rejected += 1;
    else counts.approved += 1;
  }
  return counts;
}

/**
 * The proposal's meta line. Cards: "9 to decide", "5 of 9 to decide · 2
 * approved, 1 rejected, 1 failed", "7 approved, 2 rejected". A records
 * proposal (`records`: its two or more record changes) counts the records
 * themselves: "64 records to decide", "40 of 64 records to decide · 24
 * approved", "62 applied, 2 rejected".
 */
export function proposalProgressWords(cards: readonly SubjectCard[], records?: readonly OrgProposalChange[]): string {
  if (records && records.length > 1) {
    const live = records.filter((c) => c.status !== "removed");
    const n = (...statuses: OrgChangeStatus[]) => live.filter((c) => statuses.includes(c.status)).length;
    const total = live.length, waiting = n("proposed");
    if (total === 0) return "";
    if (waiting === total) return `${total} records to decide`;
    const decided = [n("applied") && `${n("applied")} applied`, n("accepted") && `${n("accepted")} approved`, n("skipped") && `${n("skipped")} rejected`, n("failed") && `${n("failed")} failed`].filter(Boolean).join(", ");
    return waiting === 0 ? decided : `${waiting} of ${total} records to decide · ${decided}`;
  }
  const c = subjectCounts(cards);
  if (c.total === 0) return "";
  if (c.waiting === c.total) return `${c.total} to decide`;
  const decided = [c.approved && `${c.approved} approved`, c.rejected && `${c.rejected} rejected`, c.failed && `${c.failed} failed`].filter(Boolean).join(", ");
  return c.waiting === 0 ? decided : `${c.waiting} of ${c.total} to decide · ${decided}`;
}

/** The card that holds a change, by its number: a drawn change, one that
 *  rides along, or a task its plan closes. Null for a number the proposal
 *  does not have, or a removed change. */
export function subjectOfSeq(cards: readonly SubjectCard[], seq: number): SubjectCard | null {
  return cards.find((card) => membersOf(card).some((m) => m.seq === seq)) ?? null;
}

/** The tasks a proposal's changes name: the ones it marks, and the ones a
 *  plan change closes with the plan. What the live read needs, never the
 *  whole task collection. */
export function namedTaskRefs(changes: readonly Pick<OrgProposalChange, "change" | "status">[]): string[] {
  const refs = changes.filter((c) => c.status !== "removed").flatMap((c) => (c.change.kind === "task_status" ? [c.change.task] : planCarriedTasks(c.change)));
  return [...new Set(refs.map((r) => r.trim()).filter(Boolean))];
}

// ---------------------------------------------------------------- record groups

const CLOSING_ACTS = new Set(["done", "dropped", "abandoned"]);

/**
 * A records proposal as group rows (org-staffing.md S9): one per
 * orgRecordGroups entry, in its order (biggest first, loose last), each with
 * its title, its totals line and its rows as sentences. A proposal whose
 * records all fall in one loose group is "All N records" and that row carries
 * the proposal's totals; a loose group among others is "Not under a project".
 */
export function recordGroupCards(changes: readonly OrgProposalChange[], names?: OrgAskNames): RecordGroupCard[] {
  const live = changes.filter((c) => c.status !== "removed");
  const bySeq = new Map(live.map((c) => [c.seq, c]));
  const groups = orgRecordGroups(live, names);
  const lone = groups.length === 1;
  return groups.map((group) => {
    const members = group.seqs.flatMap((seq) => { const c = bySeq.get(seq); return c ? [c] : []; });
    const rows = members.map((c): RecordRow => {
      const change = editedOrgChange(c.change, c.edits);
      const w = changeWords(change, { names, seq: c.seq });
      const closing = (change.kind === "task_status" || change.kind === "plan_status" || change.kind === "project_status") && CLOSING_ACTS.has(recordAct(change));
      return { seq: c.seq, change: c, sentence: w.sentence, subjectSpan: w.subjectSpan, status: c.status, reason: w.reason ?? "", closed: closing, ...(c.status === "failed" ? { failed: c.applied_note?.trim() ?? "" } : {}) };
    });
    const title = group.kind === "loose" ? (lone ? `All ${members.length} records` : "Not under a project") : group.title ?? group.ref ?? group.key;
    return {
      key: `group:${group.key}`,
      group,
      title,
      // "N plans" and "Not under a project" carry their own kind in the title.
      kindWord: group.kind === "project" || group.kind === "plan" ? group.kind : null,
      totals: lone ? proposalTotals(live, names).line ?? recordTotalsWords(group.totals) : recordTotalsWords(group.totals),
      rows,
      change_ids: orderChanges(members).map((c) => c._id),
      seqs: [...group.seqs],
      status: subjectStatus(members),
      waiting: members.filter((c) => isOrgChangeDecidable(c.status)).length,
      failed: members.filter((c) => c.status === "failed").length,
      reply: latestReply(members),
    };
  });
}

// ---------------------------------------------------------------- the model

const NOUN: Partial<Record<OrgChange["kind"], string>> = { role: "the role", initiative: "the goal", plan_status: "the plan", file: "the plan", task_status: "the task", project_status: "the project", upgrade: "the instance" };
const THIS: Record<SubjectKind, string> = { goal: "this goal", project: "this project", role: "this role", plan: "this plan", task: "this task", projects: "these projects", instance: "this instance" };
const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

type Before = NonNullable<ChangeWordsCtx["before"]>;

/**
 * One proposal's changes as cards. `changes` are the whole proposal's rows
 * (a page that holds several proposals calls once per proposal and reads
 * `card.proposal_id`); `live` is what a before is read from, null for a
 * proposal of another workspace.
 */
export function proposalSubjects(changes: readonly OrgProposalChange[], live: SubjectLive | null, opts: SubjectOptions = {}): SubjectCard[] {
  const tree = live?.tree ?? null;
  const projects: NamedRow[] = (live?.projects ?? []).map((p) => ({ id: p._id, title: p.title, short_id: p.short_id }));
  const plans: NamedRow[] = (live?.plans ?? []).map((p) => ({ id: p._id, title: p.title, short_id: p.short_id }));
  const ghost: OrgGhostOptions = { viewerSession: opts.viewerSession, ...(live ? { projects, plans } : {}) };
  const treeRows = proposalChangeRows(tree, changes, { ...ghost, goals: live?.goals });
  const rowOf = new Map(treeRows.map((r) => [r.change_id, r]));
  const edited = (c: OrgProposalChange) => editedOrgChange(c.change, c.edits);
  const all = changes.filter((c) => c.status !== "removed").sort((a, b) => a.seq - b.seq);

  // ---- the purpose: the one top level goal this proposal sets, when another of its goals sits under it.
  const goalRows = treeRows.filter((r) => r.node.kind === "goal");
  const tops = goalRows.filter((r) => r.kind === "initiative" && !r.parent);
  const purposeId = tops.length === 1 && goalRows.some((r) => r.node.id !== tops[0].node.id && r.parent?.id === tops[0].node.id) ? tops[0].node.id : null;

  // ---- names: the tree's, the workspace's records, and what this proposal itself creates.
  const setHere: NamedRow[] = goalRows.filter((r) => r.kind === "initiative").map((r) => ({ id: r.node.id, title: r.node.name }));
  const goals: NamedRow[] = [...setHere, ...(live?.goals ?? []).map((g) => ({ id: g._id, title: g.title, short_id: g.short_id }))];
  // The sentence names an offered session only when it has a title of its own; a field names it as the tree row does ("Offered session").
  const offered = new Map<string, string>(), seated = new Map<string, string>();
  for (const r of treeRows) {
    if (r.kind !== "adopt" || r.node.kind !== "session") continue;
    seated.set(r.change_id, r.node.name);
    if (!r.node.stub?.this_session && r.node.name !== "Offered session") offered.set(r.node.short_id, r.node.name);
  }
  const base = askNames(tree, {
    projects, plans, goals,
    roles: all.map(edited).flatMap((ch) => (ch.kind === "role" ? [{ handle: ch.handle, name: ch.name }] : [])),
    sessions: (ref) => offered.get(ref),
  })!;
  // A goal named as a parent reads as "the purpose" when it is the one (the subject's own name is always passed in).
  const names: OrgAskNames = { ...base, initiative: (ref) => (purposeId !== null && goals.find((row) => refMatches(ref, row))?.id === purposeId ? PURPOSE : base.initiative?.(ref)) };
  const fieldNames = (c: OrgProposalChange): OrgAskNames => (seated.has(c._id) ? { ...names, session: (ref) => offered.get(ref) ?? seated.get(c._id) } : names);
  const projectName = (ref: string) => names.project?.(ref) ?? ref;

  // ---- live records by the ref a change writes.
  const liveRole = (handle: string): OrgRole | undefined => tree?.roles.find((r) => r.status !== "retired" && bare(r.handle) === bare(handle));
  const liveProject = (ref: string) => { const hit = refResolves(ref, projects); return hit ? live!.projects.find((p) => p._id === hit.id) : undefined; };
  const livePlan = (ref: string) => { const hit = plans.find((p) => refMatches(ref, p)); return hit ? live!.plans.find((p) => p._id === hit.id) : undefined; };
  const liveTask = (ref: string) => live?.tasks.find((t) => t._id === ref || t.short_id.toLowerCase() === ref.trim().toLowerCase());
  const liveGoal = (id: string) => live?.goals.find((g) => g._id === id);
  const partyName = (ref: OrgParentRef | null | undefined): string | undefined => (ref && tree ? partyFace(tree, ref)?.name : undefined);
  const titleOf = (id: string) => live?.projects.find((p) => p._id === id)?.title ?? live?.plans.find((p) => p._id === id)?.title ?? liveGoal(id)?.title;

  /** The stamp row that is the change's own before and after: the first whose kind is the change's, else the first. */
  const ownStamp = (c: OrgProposalChange): OrgAppliedDiffRow | undefined => { const rows = c.applied_diff ?? []; return rows.find((r) => r.kind === edited(c).kind) ?? rows[0]; };
  /** The stamp rows beyond the change's own: what landing it added elsewhere. */
  const extraStamps = (c: OrgProposalChange): OrgAppliedDiffRow[] => { const own = ownStamp(c); return (c.applied_diff ?? []).filter((r) => r !== own); };

  // ---- what a record read as before, by log field, with the names of the ids it holds.
  const labelsOf = (ids: (string | undefined)[], name: (id: string) => string | undefined): Record<string, string> =>
    Object.fromEntries(ids.flatMap((id) => { const n = id ? name(id) : undefined; return id && n ? [[id, n]] : []; }));
  const projectBefore = (p: SubjectLive["projects"][number]): Before => ({
    priority: p.priority ?? null, owner_role_id: p.owner_role_id ?? null, goal: p.goal ?? null, success_metrics: p.success_metrics ?? null, non_goals: p.non_goals ?? null, risks: p.risks ?? null, status: p.status,
    labels: labelsOf([p.owner_role_id], (id) => tree?.roles.find((r) => r._id === id)?.name),
  });
  const planBefore = (p: SubjectLive["plans"][number]): Before => ({ status: p.status, project_id: p.project_id ?? null, labels: labelsOf([p.project_id], titleOf) });
  const roleBefore = (r: OrgRole): Before => ({
    reports_to: r.reports_to, scope: r.scope, trust: r.trust ?? null, authority: (r as { authority?: unknown }).authority ?? null, standing_session: r.standing ? { short_id: r.standing.short_id } : null, charter: r.charter ?? null,
    labels: {
      ...Object.fromEntries([...r.scope_names.projects, ...r.scope_names.plans].map((x) => [x.id, x.title])),
      ...labelsOf([r.reports_to.kind === "user" ? r.reports_to.user_id : r.reports_to.role_id], () => partyName(r.reports_to)),
    },
  });
  const goalBefore = (g: InitiativeRow): Before => ({
    parent_initiative_id: g.parent_initiative_id ?? null, metrics: g.metrics ?? null, why: g.why ?? null, done_when: g.done_when ?? null, project_ids: g.project_ids ?? null, owner: g.owner ?? null,
    labels: {
      ...labelsOf([g.parent_initiative_id, ...(g.project_ids ?? [])], titleOf),
      ...labelsOf([g.owner ? (g.owner.kind === "user" ? g.owner.user_id : g.owner.role_id) : undefined], () => partyName(g.owner as OrgParentRef)),
    },
  });

  /** Which before a change's fields read (the table in the plan): the live
   *  record while it waits, the stamp once applied, nothing for a workspace
   *  whose records are not in hand. A rejected change wrote nothing, so the
   *  live record is still its before. */
  /** The names a stamp's ids read by: the stamp's own labels, else what the tree and the records know. */
  const stampLabels = (stamp: OrgAppliedDiffRow): Record<string, string> => {
    const out: Record<string, string> = {};
    const name = (id: unknown, lookup: (id: string) => string | undefined) => { if (typeof id === "string" && id && !out[id]) { const n = lookup(id); if (n) out[id] = n; } };
    for (const side of [stamp.before, stamp.after] as Record<string, unknown>[]) {
      for (const key of ["reports_to", "owner"]) { const r = side[key] as OrgParentRef | null | undefined; if (r && typeof r === "object") name(r.kind === "user" ? r.user_id : r.role_id, () => partyName(r)); }
      name(side.owner_role_id, (id) => tree?.roles.find((r) => r._id === id)?.name);
      for (const key of ["project_id", "parent_initiative_id"]) name(side[key], titleOf);
      for (const id of [...strings(side.project_ids), ...strings((side.scope as { project_ids?: unknown } | null)?.project_ids), ...strings((side.scope as { plan_ids?: unknown } | null)?.plan_ids)]) name(id, titleOf);
    }
    return { ...out, ...stamp.labels };
  };
  const wasOf = (c: OrgProposalChange, record: Before | undefined): Before | undefined => {
    if (!live) return undefined;
    if (c.status === "applied") { const stamp = ownStamp(c); return stamp ? { ...(stamp.before as Before), labels: stampLabels(stamp) } : undefined; }
    return record;
  };
  const recordOf = (c: OrgProposalChange): Before | undefined => {
    const ch = edited(c);
    switch (ch.kind) {
      case "project_meta": case "project_status": { const p = liveProject(ch.project); return p && projectBefore(p); }
      case "plan_status": case "file": { const p = livePlan(ch.plan); return p && planBefore(p); }
      case "task_status": { const t = liveTask(ch.task); return t && { status: t.status }; }
      case "move": case "scope": case "trust": case "adopt": case "authority": case "charter_edit": { const r = liveRole(ch.handle); return r && roleBefore(r); }
      case "initiative_shape": case "initiative_projects": case "initiative_owner": { const row = rowOf.get(c._id); const g = row ? liveGoal(row.node.id) : undefined; return g && goalBefore(g); }
      default: return undefined;
    }
  };

  // ---- faces beside a value.
  const faceOfRef = (ref: FieldRef, c: OrgProposalChange): ProposalTreeFace | null => {
    const row = rowOf.get(c._id);
    switch (ref.kind) {
      case "role": {
        const role = tree?.roles.find((r) => r._id === ref.id || bare(r.handle) === bare(ref.id));
        if (role && tree) return partyFace(tree, { kind: "role", role_id: role._id });
        // A role this proposal creates: the tree row already knows its face.
        const parent = row?.parent;
        return parent?.kind === "role" && bare(parent.handle) === bare(ref.id) ? parent : null;
      }
      // A person by id, "me" (the reader), or the name a change was written with ("Cam").
      case "person": {
        if (!tree) return null;
        const person = tree.people.find((p) => (ref.id === "me" ? p.is_me : p.user_id === ref.id || p.name.trim().toLowerCase() === ref.id.trim().toLowerCase()));
        return person ? partyFace(tree, { kind: "user", user_id: person.user_id }) : null;
      }
      case "goal": { const g = goals.find((x) => refMatches(ref.id, x)); return g ? { kind: "goal", id: g.id, name: g.title } : null; }
      case "project": { const p = refResolves(ref.id, projects); return p ? { kind: "record", record: "project", id: p.id, name: p.title } : null; }
      case "plan": { const p = plans.find((x) => refMatches(ref.id, x)); return p ? { kind: "record", record: "plan", id: p.id, name: p.title } : null; }
      default: return null;
    }
  };

  // ---- the sentence's context: what to call the subject, and what a priority was.
  const ctxFor = (c: OrgProposalChange, kind: SubjectKind, title: string, how: "named" | "this"): ChangeWordsCtx => {
    const ch = edited(c), row = rowOf.get(c._id);
    const purpose = ch.kind === "initiative" && !!row && row.node.id === purposeId;
    const subject = how === "this" ? THIS[kind] : NOUN[ch.kind] && !purpose ? `${NOUN[ch.kind]} ${title}` : title;
    const priority = ch.kind === "project_meta" ? wasOf(c, recordOf(c))?.priority : undefined;
    return { names, subject, ...(purpose ? { purpose: true } : {}), ...(priority !== undefined ? { was: { priority: (priority as OrgPriority | null) ?? null } } : {}) };
  };

  // ---- grouping.
  const considered = opts.seqs ? all.filter((c) => opts.seqs!.has(c.seq)) : all;
  const nested = syncGroupSummary(considered).nested;
  const carriedIds = new Set(Object.values(nested).flat().map((c) => c._id));
  type Group = { key: string; changes: OrgProposalChange[]; riders: OrgProposalChange[]; carried: OrgProposalChange[] };
  const groups = new Map<string, Group>();
  const groupOf = (key: string) => { let g = groups.get(key); if (!g) groups.set(key, (g = { key, changes: [], riders: [], carried: [] })); return g; };
  for (const c of considered) {
    if (carriedIds.has(c._id)) continue;
    const ch = edited(c);
    const group = groupOf(subjectKeyOf(rowOf.get(c._id) ?? { change_id: c._id, node: { kind: "unknown", id: c._id, name: "" } }, ch, plans));
    (isOrgQuietChange(ch) ? group.riders : group.changes).push(c);
    group.carried.push(...(nested[c._id] ?? []));
  }

  const sentenceOf = (group: Group, kind: SubjectKind, title: string, isNew: boolean, how: "named" | "this"): string => {
    const [first, ...rest] = group.changes;
    if (!first) return quietChangeSentence(edited(group.riders[0]), how === "this" ? capital(THIS[kind]) : title);
    return subjectWords(edited(first), rest.map(edited), { ...ctxFor(first, kind, title, how), isNew }).sentence;
  };

  // ---- cards.
  const roleFace = (handle: string, rows: ProposalTreeRow[]): ProposalTreeFace => {
    for (const r of rows) {
      if (r.kind !== "adopt" && r.node.kind === "role") return r.node;
      if (r.kind === "adopt" && r.parent?.kind === "role") return r.parent;
    }
    const role = liveRole(handle);
    return (role && tree ? partyFace(tree, { kind: "role", role_id: role._id }) : null) ?? { kind: "unknown", id: bare(handle), name: `@${bare(handle)}` };
  };
  const faceOf = (group: Group, kind: SubjectKind): ProposalTreeFace => {
    const first = group.changes[0] ?? group.riders[0], ch = edited(first), rows = group.changes.map((c) => rowOf.get(c._id)).filter((r): r is ProposalTreeRow => !!r);
    switch (kind) {
      case "role": return roleFace((ch as { handle: string }).handle, rows);
      case "plan": {
        const ref = (ch as { plan: string }).plan, plan = livePlan(ref);
        const title = rows.find((r) => r.kind === "plan_status")?.node.name;
        return { kind: "record", record: "plan", id: plan?._id ?? ref, name: title && title !== ref ? title : plan?.title ?? ref };
      }
      case "instance": return { kind: "unknown", id: (ch as { instance: string }).instance, name: (ch as { instance: string }).instance };
      case "projects": {
        const entries = ch.kind === "projects" ? ch.changes : [];
        const name = entries.length === 1 ? (entries[0].op === "create" ? entries[0].title : projectName(entries[0].from)) : plural(entries.length, "project");
        return { kind: "unknown", id: first._id, name };
      }
      case "task": {
        const node = rows[0]?.node ?? { kind: "record" as const, record: "task" as const, id: (ch as { task: string }).task, name: (ch as { task: string }).task };
        return node.name === node.id ? { ...node, name: liveTask(node.id)?.title ?? node.name } : node;
      }
      default: return rows[0]?.node ?? { kind: "unknown", id: group.key, name: group.key };
    }
  };
  const sitsOf = (group: Group, kind: SubjectKind, rows: ChangeField[]): string | null => {
    const first = group.changes[0] ?? group.riders[0], row = rowOf.get(first._id);
    if (kind === "goal") return rows.some((r) => r.key === "parent") || row?.parent?.kind !== "goal" ? null : capital(`under ${row.parent.id === purposeId ? PURPOSE : row.parent.name}`);
    if (kind !== "role" || rows.some((r) => r.key === "reports_to")) return null;
    const role = liveRole((edited(first) as { handle: string }).handle);
    const parent = row?.kind === "role" ? row.parent : role && tree ? partyFace(tree, role.reports_to) : null;
    return parent && parent.kind !== "unknown" ? `Reports to ${parent.kind === "person" && parent.me ? "you" : parent.name}` : null;
  };

  const cards = [...groups.values()].map((group): SubjectCard & { parentKey: string | null; rank: number } => {
    const kind = group.key.slice(0, group.key.indexOf(":")) as SubjectKind;
    // Reading order: the change that creates the subject leads, then the author's numbers.
    const creates = (c: OrgProposalChange) => { const k = edited(c).kind; return k === "role" || k === "initiative"; };
    group.changes.sort((a, b) => Number(creates(b)) - Number(creates(a)) || a.seq - b.seq);
    const drawn = group.changes;
    const members = [...drawn, ...group.carried, ...group.riders];
    const face = faceOf(group, kind);
    const title = face.name;
    const isNew = !!drawn[0] && creates(drawn[0]);
    const faces: Record<string, ProposalTreeFace> = {};
    const rows = drawn.flatMap((c): ChangeField[] => {
      const ch = edited(c);
      const fields = changeWords(ch, { ...ctxFor(c, kind, title, "named"), names: fieldNames(c), before: wasOf(c, recordOf(c)), status: c.status, seq: c.seq }).fields;
      for (const f of fields) for (const side of ["before", "after"] as const) {
        const ref = f[side]?.ref;
        const fc = ref && faceOfRef(ref, c);
        if (fc) faces[`${c.seq}:${f.key}:${side}`] = fc;
      }
      // A plan close names the tasks it closes with it; what landing a change added beyond its own record (a goal's sources) is one list after the change's own.
      const closes = (nested[c._id] ?? []).map((t) => { const task = edited(t); return task.kind === "task_status" ? task.title?.trim() || liveTask(task.task)?.title || task.task : ""; }).filter(Boolean);
      const sources = c.status === "applied" ? [...new Set(extraStamps(c).flatMap((r) => strings(r.added?.sources)))] : [];
      return [
        ...fields,
        ...(closes.length ? [{ key: "carried", label: "Closes with it", kind: "list" as const, op: "set" as const, before: null, after: { text: andList(closes), items: closes }, seq: c.seq }] : []),
        ...(sources.length ? [{ key: "sources", label: "Sources added", kind: "list" as const, op: "add" as const, before: null, after: { text: andList(sources), items: sources }, seq: c.seq }] : []),
      ];
    });
    const sentence = sentenceOf(group, kind, title, isNew, "named");
    const at = title ? sentence.indexOf(title) : -1;
    const leadRow = drawn[0] ? rowOf.get(drawn[0]._id) : undefined;
    const reportsTo = drawn.map((c) => rowOf.get(c._id)).find((r) => (r?.kind === "role" || r?.kind === "move") && r.parent?.kind === "role")?.parent;
    const priority = [...drawn].reverse().map((c) => edited(c)).find((ch) => ch.kind === "project_meta" && ch.priority) as { priority?: OrgPriority } | undefined;
    return {
      key: group.key,
      kind,
      proposal_id: members[0].proposal_id,
      face,
      title,
      isNew,
      purpose: kind === "goal" && purposeId !== null && leadRow?.node.id === purposeId,
      struck: drawn.some((c) => edited(c).kind === "retire" || !!rowOf.get(c._id)?.closes),
      changes: drawn,
      riders: group.riders,
      carried: group.carried,
      change_ids: orderChanges(members).map((c) => c._id),
      seqs: drawn.map((c) => c.seq).sort((a, b) => a - b),
      status: subjectStatus(members),
      waiting: members.filter((c) => isOrgChangeDecidable(c.status)).length,
      sentence,
      subjectSpan: at >= 0 ? [at, at + title.length] : null,
      sentenceThis: sentenceOf(group, kind, title, isNew, "this"),
      rows,
      faces,
      reasons: dedupe(drawn.map((c) => c.rationale?.trim() ?? "").filter(Boolean), (r) => r.toLowerCase()),
      // A record's `reason` ("shipped on main") is what the agent saw, not why: it reads as a source.
      evidence: dedupe(drawn.flatMap((c) => {
        const ch = edited(c), raw = ch as { evidence?: unknown; sources?: unknown };
        return [...(c.evidence ?? []), ...[...strings(raw.evidence), ...strings(raw.sources), syncEvidence(ch) ?? ""].filter(Boolean).map((label): OrgEvidenceLink => ({ label }))];
      }), (e) => `${e.label}\u0001${e.href ?? ""}`),
      sits: sitsOf(group, kind, rows),
      failed: members.filter((c) => c.status === "failed").map((c) => ({ seq: c.seq, note: c.applied_note?.trim() ?? "" })),
      reply: latestReply(members),
      depends: dedupe(drawn.map((c) => c.depends?.trim() ?? "").filter(Boolean), (d) => d),
      revisions: drawn.filter((c) => c.revision).map((c) => ({
        seq: c.seq, word: revisionWord(c.revision!), note: c.revision!.note,
        fields: c.revision!.kind === "amended" && c.revision!.before ? fieldMoves(c.revision!.before, edited(c), { names, seq: c.seq }) : [],
      })),
      parentKey: kind === "goal" ? (leadRow?.parent?.kind === "goal" ? `goal:${leadRow.parent.id}` : null) : kind === "role" && reportsTo?.kind === "role" ? `role:${bare(reportsTo.handle)}` : null,
      rank: kind === "project" ? PRIORITY_RANK[priority?.priority ?? (liveProject(face.id)?.priority as string)] ?? 9 : 0,
    };
  });

  // ---- order: by kind, goals and roles parents first, projects by the priority they are left with, the rest by
  // number; within a kind an ending (a retirement, a record closed) comes after what goes on.
  const lowest = (card: SubjectCard) => Math.min(...membersOf(card).map((m) => m.seq));
  const ordered = KIND_ORDER.flatMap((kind) => {
    const of = cards.filter((card) => card.kind === kind).sort((a, b) => Number(a.struck) - Number(b.struck) || a.rank - b.rank || lowest(a) - lowest(b));
    return kind === "goal" || kind === "role" ? treeOrder(of, (card) => card.key, (card) => card.parentKey) : of;
  });
  return ordered.map(({ parentKey: _parentKey, rank: _rank, ...card }) => card);
}
