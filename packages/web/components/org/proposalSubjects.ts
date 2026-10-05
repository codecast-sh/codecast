// A proposal's changes as cards, one per subject (org-staffing.md S39): every
// change to one goal, one project, one role or one record reads as one plain
// sentence, a few field rows with what was there before, and the reasons.
// Pure: no React, no store. Built on `proposalChangeRows`, the rows the chart
// and the company document already draw from, so a ref is resolved once and a
// card never disagrees with them about who or what a change names. The
// sentences are the shared contract's (`changeClauses`); this file only says
// which changes belong together and what each field read as before.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import type { OrgAppliedDiffRow } from "@codecast/shared/contracts/orgChange";
import {
  andList, authorityWords, changeClauses, editedOrgChange, everyWords, isOrgChangeDecidable, isOrgQuietChange, quietChangeSentence,
  type ChangeWords, type OrgAskNames, type OrgAuthorityGrant, type OrgChange, type OrgChangeReply, type OrgChangeStatus, type OrgEvidenceLink, type OrgPriority,
} from "@codecast/shared/contracts/orgProposal";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { ownerRoleOf } from "../charter/charterMeta";
import { ghostScopeNames, refMatches, refResolves, type OrgGhostOptions } from "./orgLayout";
import type { OrgProposalChange } from "./orgStaffingTypes";
import type { OrgParentRef, OrgRole, OrgTree } from "./orgTypes";
import { partyFace, proposalChangeRows, treeOrder, type ProposalTreeFace, type ProposalTreeRow } from "./proposalTree";
import { askNames } from "./staffingAsks";
import { changeTenure, orderChanges, planCarriedTasks, syncEvidence, syncGroupSummary, tenureLine } from "./staffingModel";
import { amendedMoves, revisionWord, type FieldMove } from "./staffingRevise";

// ---------------------------------------------------------------- types

export type SubjectKind = "goal" | "project" | "role" | "plan" | "task" | "projects" | "instance";
export type SubjectStatus = "proposed" | "accepted" | "applied" | "skipped" | "failed" | "mixed";

/** A value a field row draws. */
export type FieldValue =
  /** Words: a goal's sentence, a status, a routine, where a goal sits. `tail`
   *  is a quiet ending drawn after them (", every week"), the way a measure's
   *  ", target" is. */
  | { kind: "text"; text: string; tail?: string }
  /** A placeholder, drawn quiet and never struck: "not set", "at the top level", "nothing", "no project", "no number yet", "nobody". */
  | { kind: "none"; text: string }
  /** A person, a role, a goal, a record. */
  | { kind: "face"; face: ProposalTreeFace; you?: boolean }
  | { kind: "priority"; priority: OrgPriority }
  /** Projects, plans, entries: running comma text. `summary` stands in for
   *  the list until a press opens it ("9 projects, through the goals below"). */
  | { kind: "names"; names: string[]; summary?: string }
  /** One per line; a target reads as written, never parsed. */
  | { kind: "measures"; measures: { name: string; target: string }[] };

/**
 * set: a field with nothing to compare (a new record, a decided change with
 * no stamp, a workspace whose records are not in hand). change: before to
 * after. add / remove: a list gains or loses entries. clear: the value goes
 * away. same: the record already reads that way.
 *
 * A list row with a before holds the WHOLE list on each side, so before and
 * after read as a diff. With no before, `after` holds only the entries the
 * change adds (add) or takes away (remove).
 */
export type FieldOp = "set" | "change" | "add" | "remove" | "clear" | "same";

export type FieldRow = {
  /** "priority", "parent", "metrics", "projects", "owner", "reports_to", "area", "starts_work", "routine", "session", "status", ... */
  key: string;
  /** Plain words that read aloud with the value: "Priority", "Sits", "Owned by". */
  label: string;
  op: FieldOp;
  /** Null: nothing to compare. */
  before: FieldValue | null;
  /** A value that goes away reads as its placeholder with `op: "clear"`. Null
   *  only where nothing follows at all: a retired role's own row. */
  after: FieldValue | null;
  /** The change that writes this row, and where it stands, so a card whose changes ended differently marks each group. */
  seq: number;
  status: OrgChangeStatus;
};

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
  /** The goal this proposal sets as the purpose: its long rows are read in full. */
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
  /** The same sentence calling the subject "this goal", "this role": subjectSentence(card, "this"). */
  sentenceThis: string;
  rows: FieldRow[];
  /** Each drawn change's reason, in reading order, repeats dropped. */
  reasons: string[];
  /** Row evidence, plus the plain strings a role or a goal change carries, repeats dropped. */
  evidence: OrgEvidenceLink[];
  /** "Under <parent goal>", "Reports to <parent>"; null when a row already says it or nothing is known. */
  sits: string | null;
  failed: { seq: number; note: string }[];
  /** The person's latest answer that still stands (S39): a rejection's or a
   *  note's words, or an approval that carried words. Null once the author
   *  amended the change after it, or when nobody answered. */
  reply: OrgChangeReply | null;
  /** What a change needs from, or gives to, another change of the proposal. */
  depends: string[];
  /** What the author's revise did (S18). */
  revisions: { seq: number; word: string; note: string; moves: FieldMove[] }[];
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

// ---------------------------------------------------------------- words

/** What a field reads as when it holds nothing. */
const NONE = { unset: "not set", top: "at the top level", nothing: "nothing", project: "no project", number: "no number yet", nobody: "nobody" } as const;
const PURPOSE = "the purpose";

const text = (t: string): FieldValue => ({ kind: "text", text: t.trim() });
const none = (t: string): FieldValue => ({ kind: "none", text: t });
const faceValue = (face: ProposalTreeFace): FieldValue => ({ kind: "face", face, ...(face.kind === "person" && face.me ? { you: true } : {}) });
const namesValue = (names: readonly string[], empty: string): FieldValue => (names.length ? { kind: "names", names: [...names] } : none(empty));
const strings = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);
const bare = (handle: string) => handle.replace(/^@/, "").trim().toLowerCase();
const statusWords = (status: string) => status.replace(/_/g, " ");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fullStop = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dedupe = <T,>(items: readonly T[], keyOf: (t: T) => string): T[] => { const seen = new Set<string>(); return items.filter((t) => { const k = keyOf(t); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** Two values that read the same: the record already holds what the change sets. */
function valueKey(v: FieldValue): string {
  switch (v.kind) {
    case "text": return `t:${v.text.trim().toLowerCase()}${v.tail?.trim().toLowerCase() ?? ""}`;
    case "none": return "none";
    case "face": return `f:${v.face.kind}:${v.face.id}`;
    case "priority": return `p:${v.priority}`;
    case "names": return `n:${v.names.map((n) => n.trim().toLowerCase()).sort().join("\u0001")}`;
    case "measures": return `m:${v.measures.map((m) => `${m.name.trim().toLowerCase()}=${m.target.trim().toLowerCase()}`).join("\u0001")}`;
  }
}

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth", "Eleventh", "Twelfth"];
const NUMBERS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** A card's place in the list as a word: "First" to "Twelfth", then "13th". */
export function ordinalWord(n: number): string {
  if (n >= 1 && n <= ORDINALS.length) return ORDINALS[n - 1];
  const tens = n % 100, ones = n % 10;
  return `${n}${tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th"}`;
}
const numberWord = (n: number) => (n >= 1 && n <= NUMBERS.length ? NUMBERS[n - 1] : String(n));

/** The single card's place line: "First of nine", "Ninth of ten", "13th of 14".
 *  A proposal of one card has no place to count: "The only change", or "The
 *  only entry" when that card holds several. Empty for a card the list does
 *  not hold. */
export function placeWords(cards: readonly SubjectCard[], card: SubjectCard): string {
  const at = cards.findIndex((c) => c.key === card.key);
  if (at < 0) return "";
  if (cards.length > 1) return `${ordinalWord(at + 1)} of ${numberWord(cards.length)}`;
  return card.changes.length + card.carried.length > 1 ? "The only entry" : "The only change";
}

// ---------------------------------------------------------------- keys and status

const HANDLE_KINDS = new Set(["role", "move", "retire", "scope", "budget", "trust", "routine", "adopt", "authority", "hire"]);
const KIND_ORDER: SubjectKind[] = ["goal", "project", "role", "plan", "task", "projects", "instance"];
type NamedRow = { id: string; title: string; short_id?: string };

/**
 * The subject a change belongs to. Everything on one handle is one role, a
 * goal's shape and its projects are one goal, a project's fields and its
 * status one project. `row` is the change's tree row (null for a quiet
 * change, which draws none); `plans` resolves a plan ref to its live id so
 * `pl-12` and the plan's id name one subject. Not `orgChangeKey`: that one
 * includes the kind and has no key for a move, a scope or a routine.
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

/** The card's status in words: "To decide", "2 to decide", "Noted" (a card
 *  the person wrote back on, still waiting on a revision), "Approved",
 *  "Rejected", "Failed", "1 of 2 approved". A card that landed in part says
 *  what was approved first: "1 of 2 approved, 1 failed". */
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

/** The proposal's cards by where they stand: what a person counts down the
 *  list. A card with anything still to decide waits; a failed one is its own
 *  count (it waits on a retry); a card decided in parts counts as approved
 *  when any part was. */
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

/** The proposal's meta line: "9 to decide" while nothing is decided, "5 of 9
 *  to decide · 2 approved, 1 rejected, 1 failed" mid way, and the outcome once
 *  nothing waits: "9 approved", "7 approved, 2 rejected". Counts are cards. */
export function proposalProgressWords(cards: readonly SubjectCard[]): string {
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

/** The card's sentence naming its subject, or calling it "this goal", "this
 *  role", for a card that titles its subject. */
export function subjectSentence(card: SubjectCard, how: "named" | "this"): string {
  return how === "this" ? card.sentenceThis : card.sentence;
}

/** The tasks a proposal's changes name: the ones it marks, and the ones a
 *  plan change closes with the plan. What the live read needs, never the
 *  whole task collection. */
export function namedTaskRefs(changes: readonly Pick<OrgProposalChange, "change" | "status">[]): string[] {
  const refs = changes.filter((c) => c.status !== "removed").flatMap((c) => (c.change.kind === "task_status" ? [c.change.task] : planCarriedTasks(c.change)));
  return [...new Set(refs.map((r) => r.trim()).filter(Boolean))];
}

// ---------------------------------------------------------------- the model

/** What a record's fields read as before a change: `get` answers undefined
 *  for a field with nothing to compare, null for one that held nothing. */
type Was = { get: (field: string) => unknown; after: (field: string) => unknown; label: (id: string) => string | undefined; stamp: OrgAppliedDiffRow | null };

const NOUN: Partial<Record<OrgChange["kind"], string>> = { role: "the role", initiative: "the goal", plan_status: "the plan", file: "the plan", task_status: "the task", project_status: "the project", upgrade: "the instance" };
const THIS: Record<SubjectKind, string> = { goal: "this goal", project: "this project", role: "this role", plan: "this plan", task: "this task", projects: "these projects", instance: "this instance" };
const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

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
  const offered = new Map<string, string>();
  for (const r of treeRows) if (r.kind === "adopt" && r.node.kind === "session" && !r.node.stub?.this_session && r.node.name !== "Offered session") offered.set(r.node.short_id, r.node.name);
  const base = askNames(tree, {
    projects, plans, goals,
    roles: all.map(edited).flatMap((ch) => (ch.kind === "role" ? [{ handle: ch.handle, name: ch.name }] : [])),
    sessions: (ref) => offered.get(ref),
  })!;
  // A goal named as a parent reads as "the purpose" when it is the one (the subject's own name is always passed in).
  const names: OrgAskNames = { ...base, initiative: (ref) => (purposeId !== null && goals.find((row) => refMatches(ref, row))?.id === purposeId ? PURPOSE : base.initiative?.(ref)) };
  const projectName = (ref: string) => names.project?.(ref) ?? ref;
  const thingName = (ref: string) => names.project?.(ref) ?? names.plan?.(ref) ?? ref;
  const under = (goalId: string | null, name: string) => `under ${goalId === purposeId ? PURPOSE : name}`;

  // ---- live records by the ref a change writes.
  const liveRole = (handle: string): OrgRole | undefined => tree?.roles.find((r) => r.status !== "retired" && bare(r.handle) === bare(handle));
  const liveProject = (ref: string) => { const hit = refResolves(ref, projects); return hit ? live!.projects.find((p) => p._id === hit.id) : undefined; };
  const livePlan = (ref: string) => { const hit = plans.find((p) => refMatches(ref, p)); return hit ? live!.plans.find((p) => p._id === hit.id) : undefined; };
  const liveTask = (ref: string) => live?.tasks.find((t) => t._id === ref || t.short_id.toLowerCase() === ref.trim().toLowerCase());
  const liveGoal = (id: string) => live?.goals.find((g) => g._id === id);
  const titleOfProject = (id: string, was?: Was) => live?.projects.find((p) => p._id === id)?.title ?? was?.label(id) ?? null;
  const titleOfPlan = (id: string, was?: Was) => live?.plans.find((p) => p._id === id)?.title ?? was?.label(id) ?? null;

  /** The stamp row that is the change's own before and after: the first whose
   *  kind is the change's. A stamp can hold more (a goal change's evidence
   *  lands as a sources-only `initiative_shape` row after it); those read as
   *  what was added, never as a second diff. A stamp with no row of the kind
   *  keeps its first row, as it always did. */
  const ownStamp = (c: OrgProposalChange): OrgAppliedDiffRow | undefined => {
    const rows = c.applied_diff ?? [];
    return rows.find((r) => r.kind === edited(c).kind) ?? rows[0];
  };
  /** The stamp rows beyond the change's own: what landing it added elsewhere. */
  const extraStamps = (c: OrgProposalChange): OrgAppliedDiffRow[] => { const own = ownStamp(c); return (c.applied_diff ?? []).filter((r) => r !== own); };

  /** Which before a change's rows read (the table in the plan): the live
   *  record while it waits, the stamp once applied, nothing for a workspace
   *  whose records are not in hand. A rejected change wrote nothing, so the
   *  live record is still its before: the card keeps the diff for a verdict
   *  given in view (nothing jumps under the pointer) and folds it on the next
   *  mount. */
  const wasOf = (c: OrgProposalChange, record: object | null | undefined): Was | null => {
    if (!live) return null;
    if (c.status === "applied") {
      const stamp = ownStamp(c);
      if (!stamp) return null;
      const before = stamp.before as Record<string, unknown>, after = stamp.after as Record<string, unknown>;
      return { get: (f) => (f in before ? before[f] ?? null : undefined), after: (f) => after[f], label: (id) => stamp.labels[id], stamp };
    }
    if (!record) return null;
    const fields = record as Record<string, unknown>;
    return { get: (f) => fields[f] ?? null, after: () => undefined, label: () => undefined, stamp: null };
  };

  // ---- values a before is read as.
  const party = (ref: unknown, was: Was): FieldValue => {
    const r = ref as OrgParentRef | null;
    if (!r) return none(NONE.nobody);
    const face = tree ? partyFace(tree, r) : null;
    const id = r.kind === "user" ? r.user_id : r.role_id;
    return face && face.kind !== "unknown" ? faceValue(face) : was.label(id) ? text(was.label(id)!) : face ? faceValue(face) : none(NONE.nobody);
  };
  const lead = (roleId: unknown, was: Was): FieldValue => {
    if (typeof roleId !== "string" || !roleId) return none(NONE.nobody);
    const role = ownerRoleOf(tree?.roles, roleId);
    return role && tree ? faceValue(partyFace(tree, { kind: "role", role_id: role._id })!) : was.label(roleId) ? text(was.label(roleId)!) : none(NONE.nobody);
  };
  const sitsValue = (goalId: unknown, was: Was): FieldValue => {
    if (typeof goalId !== "string" || !goalId) return none(NONE.top);
    const name = liveGoal(goalId)?.title ?? was.label(goalId);
    return name ? text(under(goalId, name)) : none(NONE.top);
  };
  const measuresValue = (raw: unknown, empty: string): FieldValue => {
    const list = Array.isArray(raw) ? raw.filter((m): m is { name: string; target: string } => !!m && typeof m.name === "string").map((m) => ({ name: m.name.trim(), target: String(m.target ?? "").trim() })) : [];
    return list.length ? { kind: "measures", measures: list } : none(empty);
  };
  const wordsValue = (raw: unknown, empty: string): FieldValue => (typeof raw === "string" && raw.trim() ? text(raw) : none(empty));
  const scopeTitles = (raw: unknown, was: Was): string[] => {
    const scope = raw as { project_ids?: string[]; plan_ids?: string[] } | null;
    return [...(scope?.project_ids ?? []).map((id) => titleOfProject(id, was)), ...(scope?.plan_ids ?? []).map((id) => titleOfPlan(id, was))].filter((t): t is string => !!t);
  };

  // ---- rows.
  type Row = Omit<FieldRow, "seq" | "status">;
  const setRow = (key: string, label: string, after: FieldValue): Row => ({ key, label, op: "set", before: null, after });
  /** One value against what was there. `cleared`: the change takes the value away, and `after` is its placeholder. */
  const valueRow = (c: OrgProposalChange, key: string, label: string, after: FieldValue, before: FieldValue | undefined, cleared = false): Row => {
    if (before === undefined) return { key, label, op: cleared ? "clear" : "set", before: null, after };
    // The record already reads that way. While the verdict's echo is on its
    // way the live record may have moved first, so an accepted row shows the
    // value alone and never "P0 to P0".
    if (valueKey(before) === valueKey(after)) return c.status === "accepted" || c.status === "applied" ? { key, label, op: "set", before: null, after } : { key, label, op: "same", before, after };
    return { key, label, op: cleared ? "clear" : "change", before, after };
  };
  /** A list that gains or loses entries (see FieldOp). `whole` is the list after, when a stamp holds it. */
  const listRows = (c: OrgProposalChange, key: string, label: string, empty: string, added: readonly string[], removed: readonly string[], before: readonly string[] | undefined, whole?: readonly string[]): Row[] => {
    const has = (list: readonly string[], name: string) => list.some((x) => x.trim().toLowerCase() === name.trim().toLowerCase());
    if (before === undefined) return [
      ...(added.length ? [{ key, label, op: "add" as const, before: null, after: namesValue(added, empty) }] : []),
      ...(removed.length ? [{ key, label, op: "remove" as const, before: null, after: namesValue(removed, empty) }] : []),
    ];
    const after = whole ?? [...before.filter((x) => !has(removed, x)), ...added.filter((x) => !has(before, x))];
    const gained = after.some((x) => !has(before, x)), lost = before.some((x) => !has(after, x));
    const row = valueRow(c, key, label, namesValue(after, empty), namesValue(before, empty), after.length === 0);
    return [row.op === "change" ? { ...row, op: gained && lost ? "change" : gained ? "add" : "remove" } : row];
  };
  /** A role's area after a change that adds to it or takes from it. */
  const areaRows = (c: OrgProposalChange, handle: string, add: readonly string[] | undefined, remove: readonly string[] | undefined): Row[] => {
    if (!add?.length && !remove?.length) return [];
    const role = liveRole(handle);
    const was = wasOf(c, role);
    const raw = was?.get("scope");
    const before = !was || raw === undefined ? undefined : was.stamp ? scopeTitles(raw, was) : [...role!.scope_names.projects, ...role!.scope_names.plans].map((x) => x.title);
    const whole = was?.stamp && was.after("scope") !== undefined ? scopeTitles(was.after("scope"), was) : undefined;
    return listRows(c, "area", "Looks after", NONE.nothing, (add ?? []).map(thingName), (remove ?? []).map(thingName), before, whole);
  };
  const before = (was: Was | null, field: string, read: (raw: unknown, was: Was) => FieldValue): FieldValue | undefined => {
    const raw = was?.get(field);
    return !was || raw === undefined ? undefined : read(raw, was);
  };

  const hasChildren = (goalId: string) => goalRows.some((r) => r.node.id !== goalId && r.parent?.id === goalId);

  const rowsFor = (c: OrgProposalChange): Row[] => {
    const ch = edited(c), row = rowOf.get(c._id);
    switch (ch.kind) {
      case "project_meta": {
        const was = wasOf(c, liveProject(ch.project));
        const list = (key: string, label: string, value: string[] | undefined) => (value == null ? [] : [valueRow(c, key, label, namesValue(strings(value), NONE.nothing), before(was, key, (raw) => namesValue(strings(raw), NONE.nothing)), value.length === 0)]);
        return [
          ...(ch.priority ? [valueRow(c, "priority", "Priority", { kind: "priority", priority: ch.priority }, before(was, "priority", (raw) => (typeof raw === "string" && raw in PRIORITY_RANK ? { kind: "priority", priority: raw as OrgPriority } : none(NONE.unset))))] : []),
          ...(ch.owner ? [valueRow(c, "owner", "Led by", row?.owner ? faceValue(row.owner) : text(ch.owner), before(was, "owner_role_id", lead))] : []),
          ...(ch.goal != null ? [valueRow(c, "goal", "Says", wordsValue(ch.goal, NONE.unset), before(was, "goal", (raw) => wordsValue(raw, NONE.unset)), !ch.goal.trim())] : []),
          ...list("success_metrics", "Measured by", ch.success_metrics),
          ...list("non_goals", "Leaves out", ch.non_goals),
          ...list("risks", "Risks", ch.risks),
        ];
      }
      case "project_status": case "plan_status": case "task_status": {
        const record = ch.kind === "project_status" ? liveProject(ch.project) : ch.kind === "plan_status" ? livePlan(ch.plan) : liveTask(ch.task);
        const status = valueRow(c, "status", "Status", text(statusWords(ch.status)), before(wasOf(c, record), "status", (raw) => wordsValue(typeof raw === "string" ? statusWords(raw) : raw, NONE.unset)));
        const closes = (carriedBy.get(c._id) ?? []).map((t) => { const task = edited(t); return task.kind === "task_status" ? task.title?.trim() || liveTask(task.task)?.title || task.task : ""; }).filter(Boolean);
        return closes.length ? [status, setRow("carried", "Closes with it", namesValue(closes, NONE.nothing))] : [status];
      }
      case "file": {
        const was = wasOf(c, livePlan(ch.plan));
        return [valueRow(c, "project", "Project", namesValue([projectName(ch.project)], NONE.project), before(was, "project_id", (raw, w) => namesValue(typeof raw === "string" && titleOfProject(raw, w) ? [titleOfProject(raw, w)!] : [], NONE.project)))];
      }
      case "role": {
        const area = tree ? ghostScopeNames(ch.scope, tree, ghost) : null;
        const looksAfter = area ? [...area.projects, ...area.plans].map((x) => x.title) : [...(ch.scope?.projects ?? []).map(projectName), ...(ch.scope?.plans ?? []).map((ref) => names.plan?.(ref) ?? ref)];
        const stays = tenureLine(changeTenure(c), tree);
        return [
          setRow("handle", "Answers to", text(`@${bare(ch.handle)}`)),
          setRow("area", "Looks after", namesValue(looksAfter, NONE.nothing)),
          ...(ch.seat ? [setRow("session", "Session", text(ch.seat.title?.trim() || names.session?.(ch.seat.existing) || ch.seat.existing))] : []),
          ...(stays ? [setRow("stays", "Stays", text(stays))] : []),
        ];
      }
      case "move": {
        const role = liveRole(ch.handle), was = wasOf(c, role);
        // While the move waits, the tree row already knows where the role reports now (`from`, else where it stays).
        const reported = !was ? undefined : was.stamp ? before(was, "reports_to", party) : row?.from ? faceValue(row.from) : party(role?.reports_to, was);
        return [
          ...(ch.reports_to ? [valueRow(c, "reports_to", "Reports to", row?.parent ? faceValue(row.parent) : text(ch.reports_to.trim().toLowerCase() === "me" ? "you" : ch.reports_to), reported)] : []),
          ...areaRows(c, ch.handle, ch.scope_add, ch.scope_remove),
        ];
      }
      case "scope": return areaRows(c, ch.handle, ch.add, ch.remove);
      case "trust": {
        const starts = (trust: unknown) => text(autonomyOn(typeof trust === "string" ? trust : null) ? "on its own, inside its area" : "when you start it");
        return [valueRow(c, "starts_work", "Starts work", starts(ch.trust), before(wasOf(c, liveRole(ch.handle)), "trust", starts))];
      }
      case "routine": return [setRow("routine", "Runs", { kind: "text", text: ch.title.trim(), tail: `, ${everyWords(ch.every)}` })];
      // A retirement: the role, struck, with nothing after it (the sentence says where its sessions go).
      case "retire": return [{ key: "role", label: "Role", op: "clear", before: faceValue(roleFace(ch.handle, row ? [row] : [])), after: null }];
      case "adopt": {
        const role = liveRole(ch.handle), was = wasOf(c, role);
        const seated = !was ? undefined : was.stamp
          ? before(was, "standing_session", (raw) => wordsValue((raw as { short_id?: string } | null)?.short_id, NONE.unset))
          : wordsValue(role?.standing?.conversation_id ? role.sessions.find((s) => s._id === role.standing!.conversation_id)?.title ?? role.standing.short_id : null, NONE.unset);
        return [valueRow(c, "session", "Session", text(row?.node.name ?? ch.conversation), seated)];
      }
      case "authority": {
        const may = (raw: unknown) => (Array.isArray(raw) && raw.length ? text(authorityWords(raw as OrgAuthorityGrant[])) : none(NONE.nothing));
        return [valueRow(c, "may", "May", may(ch.authority), before(wasOf(c, liveRole(ch.handle)), "authority", may), ch.authority.length === 0)];
      }
      case "hire": return [setRow("hired", "Hired from", text(`${ch.template} (${ch.version})`)), setRow("leads", "Leads", namesValue([projectName(ch.project)], NONE.project))];
      case "initiative": {
        const id = row?.node.id ?? "";
        const carriers = ch.projects.map(projectName);
        const carried: FieldValue = carriers.length && hasChildren(id) ? { kind: "names", names: carriers, summary: `${plural(carriers.length, "project")}, through the goals below` } : namesValue(carriers, NONE.project);
        return [
          setRow("owner", "Owned by", row?.owner ? faceValue(row.owner) : ch.owner?.trim() ? text(ch.owner) : none(NONE.nobody)),
          // The purpose is read through the goals under it; every other goal says when it has no number.
          ...(ch.metrics?.length || id !== purposeId ? [setRow("metrics", "Measured by", measuresValue(ch.metrics, NONE.number))] : []),
          setRow("projects", "Carried by", carried),
          ...(ch.description?.trim() ? [setRow("says", "Says", text(ch.description))] : []),
          ...(ch.why?.trim() ? [setRow("why", "Why it matters", text(ch.why))] : []),
          ...(ch.done_when?.trim() ? [setRow("done_when", "Done when", text(ch.done_when))] : []),
          ...(ch.milestones?.length ? [setRow("milestones", "Milestones", namesValue(ch.milestones.map((m) => m.title.trim()), NONE.nothing))] : []),
          ...(ch.target_date ? [setRow("due", "Due", text(new Date(ch.target_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })))] : []),
        ];
      }
      case "initiative_shape": {
        const was = wasOf(c, row ? liveGoal(row.node.id) : null);
        const parentId = row?.parent?.kind === "goal" ? row.parent.id : null;
        // What an accept added to the record is the stamp's to say; while it waits, the change's own entries.
        const added = (list: "milestones" | "questions" | "decisions", proposed: readonly string[] | undefined) => was?.stamp ? was.stamp.added?.[list] ?? [] : proposed ?? [];
        const entries = (key: "milestones" | "questions" | "decisions", label: string, proposed: readonly string[] | undefined) => listRows(c, key, label, NONE.nothing, added(key, proposed).map((x) => x.trim()).filter(Boolean), [], undefined);
        return [
          ...(ch.parent !== undefined ? [valueRow(c, "parent", "Sits", ch.parent === null ? none(NONE.top) : text(under(parentId, row?.parent?.name ?? ch.parent)), before(was, "parent_initiative_id", sitsValue))] : []),
          ...(ch.metrics !== undefined ? [valueRow(c, "metrics", "Measured by", measuresValue(ch.metrics, NONE.nothing), before(was, "metrics", (raw) => measuresValue(raw, NONE.nothing)), ch.metrics.length === 0)] : []),
          ...(ch.why !== undefined ? [valueRow(c, "why", "Why it matters", wordsValue(ch.why, NONE.unset), before(was, "why", (raw) => wordsValue(raw, NONE.unset)), !ch.why.trim())] : []),
          ...(ch.done_when !== undefined ? [valueRow(c, "done_when", "Done when", wordsValue(ch.done_when, NONE.unset), before(was, "done_when", (raw) => wordsValue(raw, NONE.unset)), !ch.done_when.trim())] : []),
          ...entries("milestones", "Milestones", ch.milestones?.map((m) => m.title)),
          ...entries("questions", "Open questions", ch.questions),
          ...entries("decisions", "Decisions", ch.decisions),
        ];
      }
      case "initiative_projects": {
        const was = wasOf(c, row ? liveGoal(row.node.id) : null);
        const titles = (raw: unknown, w: Was) => strings(raw).map((id) => titleOfProject(id, w)).filter((t): t is string => !!t);
        const raw = was?.get("project_ids");
        const whole = was?.stamp && was.after("project_ids") !== undefined ? titles(was.after("project_ids"), was) : undefined;
        return listRows(c, "projects", "Carried by", NONE.project, ch.projects.map(projectName), [], !was || raw === undefined ? undefined : titles(raw, was), whole);
      }
      case "initiative_owner": {
        const was = wasOf(c, row ? liveGoal(row.node.id) : null);
        return [valueRow(c, "owner", "Owned by", row?.owner ? faceValue(row.owner) : ch.owner.trim() ? text(ch.owner) : none(NONE.nobody), before(was, "owner", party), !ch.owner.trim())];
      }
      case "projects": return ch.changes.map((x): Row => x.op === "create"
        ? setRow("new", "Project", text(x.title))
        : { key: "folds", label: "Folds into", op: "change", before: text(projectName(x.from)), after: text(projectName(x.into)) });
      case "upgrade": return [setRow("version", "Version", text(`${ch.template} ${ch.to}`))];
      // A limit is never a row (S23.2).
      default: return [];
    }
  };

  // ---- grouping.
  const considered = opts.seqs ? all.filter((c) => opts.seqs!.has(c.seq)) : all;
  const nested = syncGroupSummary(considered).nested;
  const carriedBy = new Map(Object.entries(nested));
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

  // ---- sentences.
  const wordsFor = (c: OrgProposalChange, kind: SubjectKind, title: string, how: "named" | "this" | "it"): ChangeWords => {
    const ch = edited(c), row = rowOf.get(c._id);
    const purpose = ch.kind === "initiative" && !!row && row.node.id === purposeId;
    // The subject is always handed over, so the sentence names it exactly as the card titles it.
    const subject = how === "it" ? "it" : how === "this" ? THIS[kind] : NOUN[ch.kind] && !purpose ? `${NOUN[ch.kind]} ${title}` : title;
    const priority = ch.kind === "project_meta" ? wasOf(c, liveProject(ch.project))?.get("priority") : undefined;
    return { names, brief: true, subject, ...(purpose ? { purpose: true } : {}), ...(priority !== undefined ? { was: { priority: (priority as OrgPriority | null) ?? null } } : {}) };
  };
  const sentenceOf = (group: Group, kind: SubjectKind, title: string, isNew: boolean, how: "named" | "this"): string => {
    const [first, ...rest] = group.changes;
    if (!first) return quietChangeSentence(edited(group.riders[0]), how === "this" ? capital(THIS[kind]) : title);
    const clauses = [
      ...changeClauses(edited(first), wordsFor(first, kind, title, how)),
      // A card that creates its subject says so and stops: what rides along is in the rows.
      ...(isNew ? [] : rest.flatMap((c) => changeClauses(edited(c), wordsFor(c, kind, title, "it")))),
    ];
    return fullStop(capital(clauses.length <= 3 ? andList(clauses) : `${clauses[0]} and ${clauses.length - 1} more changes`));
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
        // A change that names its task only by ref reads by the task's title when the store has it.
        const node = rows[0]?.node ?? { kind: "record" as const, record: "task" as const, id: (ch as { task: string }).task, name: (ch as { task: string }).task };
        return node.name === node.id ? { ...node, name: liveTask(node.id)?.title ?? node.name } : node;
      }
      default: return rows[0]?.node ?? { kind: "unknown", id: group.key, name: group.key };
    }
  };
  const sitsOf = (group: Group, kind: SubjectKind, rows: FieldRow[]): string | null => {
    const first = group.changes[0] ?? group.riders[0], row = rowOf.get(first._id);
    if (kind === "goal") return rows.some((r) => r.key === "parent") || row?.parent?.kind !== "goal" ? null : capital(under(row.parent.id, row.parent.name));
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
    // What landing a change added beyond its own record (a goal's sources) is one names row after the change's own.
    const sourcesRow = (c: OrgProposalChange): Row[] => {
      const sources = c.status === "applied" ? [...new Set(extraStamps(c).flatMap((r) => (r.added?.sources ?? []).map((s) => s.trim()).filter(Boolean)))] : [];
      return sources.length ? [{ key: "sources", label: "Sources added", op: "add", before: null, after: namesValue(sources, NONE.nothing) }] : [];
    };
    const rows = drawn.flatMap((c) => [...rowsFor(c), ...sourcesRow(c)].map((r): FieldRow => ({ ...r, seq: c.seq, status: c.status })));
    const reply = members.map(changeReply).filter((r): r is OrgChangeReply => !!r).sort((a, b) => b.at - a.at)[0] ?? null;
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
      reasons: dedupe(drawn.map((c) => c.rationale?.trim() ?? "").filter(Boolean), (r) => r.toLowerCase()),
      // A record's `reason` ("shipped on main") is what the agent saw, not why: it reads as a source.
      evidence: dedupe(drawn.flatMap((c) => {
        const ch = edited(c), raw = ch as { evidence?: unknown; sources?: unknown };
        return [...(c.evidence ?? []), ...[...strings(raw.evidence), ...strings(raw.sources), syncEvidence(ch) ?? ""].filter(Boolean).map((label): OrgEvidenceLink => ({ label }))];
      }), (e) => `${e.label}\u0001${e.href ?? ""}`),
      sits: sitsOf(group, kind, rows),
      failed: members.filter((c) => c.status === "failed").map((c) => ({ seq: c.seq, note: c.applied_note?.trim() ?? "" })),
      reply,
      depends: dedupe(drawn.map((c) => c.depends?.trim() ?? "").filter(Boolean), (d) => d),
      revisions: drawn.filter((c) => c.revision).map((c) => ({ seq: c.seq, word: revisionWord(c.revision!), note: c.revision!.note, moves: amendedMoves(c) })),
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
