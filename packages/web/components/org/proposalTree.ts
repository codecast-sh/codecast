// The small tree a proposal card draws (docs/architecture/org-staffing.md
// S24): each change as one row, "who reports to whom after the change" in the
// chart's own terms. Pure: the rows come from the SAME merge the chart draws
// its ghosts from (ghostsFor), so a card in a conversation and the org page
// never disagree about what a proposal changes. Without a tree (the org
// feeder has not answered, or the proposal belongs to another workspace) the
// rows keep their lines and statuses and lose their faces.
import { describeOrgChange, editedOrgChange, isOrgQuietChange, quietChangeSentence, type OrgChange, type OrgChangeKind, type OrgChangeStatus } from "@codecast/shared/contracts/orgProposal";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import type { OrgParentRef, OrgTree } from "./orgTypes";
import type { OrgProposalChange } from "./orgStaffingTypes";
import { ghostsFor, refResolves, roleNodeId, type OrgGhostOptions, type OrgGhostPlan, type OrgGhostStub } from "./orgLayout";
import { CHANGE_KIND_WORD } from "./orgMeta";

/** One face on a row: a person, a role (live or a stub), an offered session,
 *  a task, plan or project whose status the change sets, or a handle nothing
 *  in the workspace answers to. */
export type ProposalTreeFace =
  | { kind: "person"; id: string; name: string; image?: string; me: boolean }
  | { kind: "role"; id: string; name: string; handle: string; avatar?: string; stub?: OrgGhostStub }
  | { kind: "session"; id: string; name: string; short_id: string; stub?: OrgGhostStub }
  | { kind: "record"; id: string; name: string; record: "task" | "plan" | "project" }
  /** A company goal: a live initiative, or one this proposal sets (`proposed`). */
  | { kind: "goal"; id: string; name: string; short_id?: string; proposed?: boolean }
  | { kind: "unknown"; id: string; name: string };

export type ProposalTreeRow = {
  change_id: string;
  seq: number;
  kind: OrgChangeKind;
  status: OrgChangeStatus;
  /** The whole change in one sentence (describeOrgChange). */
  line: string;
  /** The word the row leads with: "new role", "move", "retire", "adopt", else the kind's word. */
  tag: string;
  /** What the change is about, drawn under `parent`. */
  node: ProposalTreeFace;
  /** After the change: who the node reports to (a role, a move, an adopt). */
  parent: ProposalTreeFace | null;
  /** A goal's owner after the change: a person or a role. */
  owner: ProposalTreeFace | null;
  /** A move: who the node reported to before, drawn faded. */
  from: ProposalTreeFace | null;
  /** A change that is neither a node nor an edge (scope, limit, routine, a
   *  record's status): the delta alone, read on the node. */
  chip: string | null;
  /** The subject's handle answers to nothing live: drawn as a warning. */
  unresolved: boolean;
  /** The status a record's change closes it with (done, dropped,
   *  abandoned), drawn struck so the card reads as closing the record. */
  closes: "done" | "dropped" | "abandoned" | null;
  /** The line under the row, so the card says what a message would
   *  otherwise spell out beside it: a new role's scope and seat, a record's
   *  reason for its new status. */
  detail: string | null;
};

const strip = (h: string) => h.replace(/^@/, "").trim().toLowerCase();

/** A person or a role of a tree as a face, by the ref a record stores: who a
 *  role reports to, who owns a goal. A ref the tree does not hold reads as "a
 *  person" or "a role". The subject model reads a record's before through
 *  this, so a face is built in one place. */
export function partyFace(tree: Pick<OrgTree, "people" | "roles">, ref: OrgParentRef | null | undefined, stubs: OrgGhostPlan["stubs"] = {}): ProposalTreeFace | null {
  if (!ref) return null;
  if (ref.kind === "user") {
    const p = tree.people.find((x) => x.user_id === ref.user_id);
    return p ? { kind: "person", id: p.user_id, name: p.name, image: p.image, me: p.is_me } : { kind: "unknown", id: ref.user_id, name: "a person" };
  }
  const r = tree.roles.find((x) => x._id === ref.role_id);
  return r
    ? { kind: "role", id: r._id, name: r.name, handle: r.handle, avatar: r.avatar, stub: stubs[roleNodeId(r._id)] }
    : { kind: "unknown", id: ref.role_id, name: "a role" };
}

const faceOfRef = (plan: OrgGhostPlan, ref: OrgParentRef | null | undefined): ProposalTreeFace | null => partyFace(plan.merged, ref, plan.stubs);

/** "Matching Engine & Funnel · from Market growth mandate": the scope by
 *  name (a ref the tree already knows reads as its title), then the seat. */
function roleDetail(tree: OrgTree | null, ch: { scope?: { projects?: string[]; plans?: string[] }; seat?: { title?: string } }): string {
  const known = new Map<string, string>();
  for (const r of tree?.roles ?? []) for (const x of [...r.scope_names.projects, ...r.scope_names.plans]) {
    known.set(x.id, x.title);
    if (x.short_id) known.set(x.short_id, x.title);
  }
  const scope = [...(ch.scope?.projects ?? []), ...(ch.scope?.plans ?? [])].map((ref) => known.get(ref) ?? ref);
  const seat = ch.seat ? `from ${ch.seat.title ?? "an existing session"}` : "new session";
  return [scope.length ? scope.join(", ") : "no area of its own", seat].join(" · ");
}

/** The rows of a proposal, in seq order. Removed changes are history and
 *  draw nothing; skipped ones keep a row so the card can say what happened;
 *  a quiet kind (a limit, S23.2) never draws a row (proposalQuietLines). */
export function proposalTreeRows(tree: OrgTree | null, changes: readonly OrgProposalChange[], opts: OrgGhostOptions & { goals?: readonly InitiativeRow[] } = {}): ProposalTreeRow[] {
  return nestGoalRows(proposalChangeRows(tree, changes, opts));
}

/** One row per change, before the card joins and nests them (the chart's goals lens places these). */
export function proposalChangeRows(tree: OrgTree | null, changes: readonly OrgProposalChange[], opts: OrgGhostOptions & { goals?: readonly InitiativeRow[] } = {}): ProposalTreeRow[] {
  const ordered = [...changes].filter((c) => c.status !== "removed" && !isOrgQuietChange(c.change)).sort((a, b) => a.seq - b.seq);
  return rowsOf(tree, changes, ordered, opts);
}

/** Goals draw as their tree: a goal that lands under another goal of the same
 *  card follows it, so the card reads purpose first, then what feeds it. */
function nestGoalRows(all: ProposalTreeRow[]): ProposalTreeRow[] {
  // Several changes to one existing goal read as one line: its tags and details joined.
  const rows: ProposalTreeRow[] = [];
  for (const r of all) {
    const same = r.node.kind === "goal" && r.tag !== "new" ? rows.find((x) => x.node.kind === "goal" && x.tag !== "new" && x.node.id === r.node.id) : undefined;
    if (!same) { rows.push(r); continue; }
    rows[rows.indexOf(same)] = { ...same, tag: `${same.tag}, ${r.tag}`, detail: [same.detail, r.detail].filter(Boolean).join(" · ") || null, owner: same.owner ?? r.owner, from: same.from ?? r.from, status: same.status === r.status ? same.status : "proposed", unresolved: same.unresolved || r.unresolved, line: `${same.line}; ${r.line}` };
  }
  // Only a goal row is a parent, so every other row gets an id nothing names.
  return treeOrder(rows, (r) => (r.node.kind === "goal" ? `goal:${r.node.id}` : `row:${r.change_id}`), (r) => (r.parent?.kind === "goal" ? `goal:${r.parent.id}` : null));
}

/** Parents first: an item whose parent is also in the list follows it; the
 *  rest keep their order. Items caught in a loop come last, in their order. */
export function treeOrder<T>(items: readonly T[], idOf: (t: T) => string, parentOf: (t: T) => string | null): T[] {
  const isChild = (t: T) => { const p = parentOf(t); return p !== null && items.some((x) => x !== t && idOf(x) === p); };
  const seen = new Set<T>();
  const out: T[] = [];
  const emit = (t: T) => {
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
    const id = idOf(t);
    for (const k of items) if (isChild(k) && parentOf(k) === id) emit(k);
  };
  for (const t of items) if (!isChild(t)) emit(t);
  for (const t of items) emit(t);
  return out;
}

const GOAL_KINDS = new Set<string>(["initiative", "initiative_projects", "initiative_owner", "initiative_shape"]);

function rowsOf(tree: OrgTree | null, changes: readonly OrgProposalChange[], ordered: OrgProposalChange[], opts: OrgGhostOptions & { goals?: readonly InitiativeRow[] }): ProposalTreeRow[] {
  const plan = tree ? ghostsFor(tree, changes, opts) : null;
  const liveRole = (handle: string) => plan?.merged.roles.find((r) => r.status !== "retired" && strip(r.handle) === strip(handle));
  const me = plan?.merged.people.find((p) => p.is_me) ?? plan?.merged.people[0];
  const meFace = (): ProposalTreeFace => (me ? { kind: "person", id: me.user_id, name: me.name, image: me.image, me: me.is_me } : { kind: "unknown", id: "me", name: "you" });
  const roleFace = (handle: string, name?: string): { face: ProposalTreeFace; unresolved: boolean } => {
    const r = liveRole(handle);
    if (r && plan) return { face: { kind: "role", id: r._id, name: r.name, handle: r.handle, avatar: r.avatar, stub: plan.stubs[roleNodeId(r._id)] }, unresolved: false };
    return { face: { kind: "unknown", id: strip(handle), name: name ?? `@${strip(handle)}` }, unresolved: !!plan };
  };
  // An owner the way the server resolves one (orgInit resolveReportsTo):
  // "me", "@handle" or a role's short id, else a member by name.
  const ownerFace = (ref: string | undefined): { face: ProposalTreeFace; unresolved: boolean } | null => {
    const t = ref?.trim();
    if (!t) return null;
    if (t.toLowerCase() === "me") return { face: meFace(), unresolved: false };
    const r = liveRole(t) ?? plan?.merged.roles.find((x) => x.short_id === t);
    if (r) return roleFace(r.handle);
    const lc = t.replace(/^@/, "").toLowerCase();
    const p = plan?.merged.people.find((x) => x.name.toLowerCase() === lc || x.user_id === t);
    if (p) return { face: { kind: "person", id: p.user_id, name: p.name, image: p.image, me: p.is_me }, unresolved: false };
    return { face: { kind: "unknown", id: lc, name: t.replace(/^@/, "") }, unresolved: !!plan };
  };
  // A goal by whatever names it: one this proposal sets (by title), else a
  // live initiative by in-N, id or title, else the ref as written.
  const goals = opts.goals ?? [];
  const setHere = ordered.filter((c) => editedOrgChange(c.change, c.edits).kind === "initiative");
  const goalFace = (ref: string, title?: string): ProposalTreeFace => {
    const lc = ref.trim().toLowerCase();
    const here = setHere.find((c) => (editedOrgChange(c.change, c.edits) as { title: string }).title.trim().toLowerCase() === lc);
    if (here) return { kind: "goal", id: here._id, name: (editedOrgChange(here.change, here.edits) as { title: string }).title, proposed: true };
    const live = goals.find((g) => g._id === ref || g.short_id === lc || g.title.trim().toLowerCase() === lc);
    if (live) return { kind: "goal", id: live._id, name: live.title, short_id: live.short_id };
    return { kind: "goal", id: lc, name: title?.trim() || ref };
  };
  const liveGoal = (face: ProposalTreeFace) => goals.find((g) => g._id === face.id);
  // Where a goal sits after this proposal: a shape here that places it, else where it sits now.
  const goalParent = (face: ProposalTreeFace): ProposalTreeFace | null => {
    for (const c of ordered) {
      const ch = editedOrgChange(c.change, c.edits);
      if (ch.kind === "initiative_shape" && ch.parent !== undefined && goalFace(ch.initiative, ch.title).id === face.id) return ch.parent ? goalFace(ch.parent) : null;
    }
    const pid = liveGoal(face)?.parent_initiative_id;
    const p = pid ? goals.find((g) => g._id === pid) : undefined;
    return p ? { kind: "goal", id: p._id, name: p.title, short_id: p.short_id } : null;
  };
  const projectsWords = (refs: string[]) => (refs.length <= 3 ? refs.join(", ") : `${refs.length} projects`);
  const measures = (ms: { name: string; target: string }[]) => ms.map((m) => `${m.name.trim()} → ${m.target.trim()}`).join(", ");
  const goalRow = (ch: OrgChange): Pick<ProposalTreeRow, "tag" | "node" | "parent" | "owner" | "from" | "detail" | "unresolved"> | null => {
    switch (ch.kind) {
      case "initiative": {
        const node = goalFace(ch.title);
        const owner = ownerFace(ch.owner);
        return { tag: "new", node, parent: ch.parent ? goalFace(ch.parent) : null, owner: owner?.face ?? null, from: null, unresolved: !!owner?.unresolved, detail: [ch.metrics?.length ? measures(ch.metrics) : "", projectsWords(ch.projects)].filter(Boolean).join(" · ") || null };
      }
      case "initiative_shape": {
        const node = goalFace(ch.initiative, ch.title);
        const now = liveGoal(node)?.parent_initiative_id;
        const before = now ? goals.find((g) => g._id === now) : undefined;
        const parent = goalParent(node);
        const moved = ch.parent !== undefined && (before?._id ?? null) !== (parent?.id ?? null);
        return { tag: [ch.parent === undefined ? "" : ch.parent ? "moves here" : "to the top", ch.metrics === undefined ? "" : "measured"].filter(Boolean).join(", "), node, parent, owner: null, from: moved && before ? { kind: "goal", id: before._id, name: before.title, short_id: before.short_id } : null, unresolved: false, detail: ch.metrics === undefined ? null : ch.metrics.length ? measures(ch.metrics) : "no number" };
      }
      case "initiative_projects": {
        const node = goalFace(ch.initiative, ch.title);
        return { tag: "projects added", node, parent: goalParent(node), owner: null, from: null, unresolved: false, detail: projectsWords(ch.projects) };
      }
      case "initiative_owner": {
        const node = goalFace(ch.initiative, ch.title);
        const owner = ownerFace(ch.owner);
        return { tag: "owner", node, parent: goalParent(node), owner: owner?.face ?? null, from: null, unresolved: !!owner?.unresolved, detail: null };
      }
      default: return null;
    }
  };
  // The project a change names, as a record: its live id when the workspace's
  // projects are in hand, else the ref as written. A change to its fields and a
  // change to its status name the same record, so they share a subject.
  const projectFace = (ref: string, title?: string): ProposalTreeFace => {
    const live = refResolves(ref, opts.projects ?? []);
    return { kind: "record", record: "project", id: live?.id ?? ref, name: title ?? live?.title ?? ref };
  };
  const chipOf = (changeId: string): string | null => {
    if (!plan) return null;
    for (const chips of Object.values(plan.chips)) for (const c of chips) if (c.change_id === changeId) return c.chip;
    return null;
  };

  return ordered.map((c): ProposalTreeRow => {
    const ch = editedOrgChange(c.change, c.edits);
    const base = { change_id: c._id, seq: c.seq, kind: ch.kind, status: c.status, line: describeOrgChange(ch), from: null, chip: null, unresolved: false, detail: null, closes: null, owner: null } as const;
    if (GOAL_KINDS.has(ch.kind)) return { ...base, ...goalRow(ch)! };
    switch (ch.kind) {
      case "role": {
        // The stub ghostsFor pushed (keyed by the change id), else the live
        // role the tree already carries (the proposal was superseded by it).
        const stub = plan?.merged.roles.find((r) => r._id === c._id) ?? liveRole(ch.handle);
        const node: ProposalTreeFace = stub && plan
          ? { kind: "role", id: stub._id, name: stub.name, handle: stub.handle, avatar: stub.avatar, stub: plan.stubs[roleNodeId(stub._id)] }
          : { kind: "role", id: c._id, name: ch.name, handle: strip(ch.handle), avatar: ch.avatar };
        return { ...base, tag: "new role", node, parent: stub && plan ? faceOfRef(plan, stub.reports_to) : null, detail: roleDetail(tree, ch) };
      }
      case "move": {
        const { face, unresolved } = roleFace(ch.handle);
        if (!plan || face.kind !== "role") return { ...base, tag: CHANGE_KIND_WORD.move, node: face, parent: null, unresolved };
        const move = plan.moves.find((m) => m.change_id === c._id);
        const before = tree?.roles.find((r) => r._id === face.id)?.reports_to ?? null;
        const after = plan.merged.roles.find((r) => r._id === face.id)?.reports_to ?? null;
        // A proposed move keeps the row where it is and names the edge; an
        // accepted one is already re-parented in the merged tree.
        const to = move ? move.to : after;
        const from = move ? move.from : before;
        const moved = !!to && !!from && !(to.kind === from.kind && (to.kind === "user" ? to.user_id === (from as any).user_id : to.role_id === (from as any).role_id));
        return { ...base, tag: CHANGE_KIND_WORD.move, node: face, parent: faceOfRef(plan, to), from: moved ? faceOfRef(plan, from) : null, unresolved: unresolved || (!!ch.reports_to && !to) };
      }
      case "task_status": case "plan_status": case "project_status": {
        const record = ch.kind === "task_status" ? "task" : ch.kind === "plan_status" ? "plan" : "project";
        const ref = ch.kind === "task_status" ? ch.task : ch.kind === "plan_status" ? ch.plan : ch.project;
        const closes = ch.status === "done" || ch.status === "dropped" || ch.status === "abandoned" ? ch.status : null;
        return { ...base, tag: `→ ${ch.status}`, node: ch.kind === "project_status" ? projectFace(ref, ch.title) : { kind: "record", id: ref, name: ch.title ?? ref, record }, parent: null, detail: ch.reason, closes };
      }
      case "project_meta": {
        // The project is the subject; its lead after the change rides as the owner.
        const owner = ownerFace(ch.owner);
        return { ...base, tag: CHANGE_KIND_WORD.project_meta, node: projectFace(ch.project), parent: null, owner: owner?.face ?? null, chip: chipOf(c._id), unresolved: !!owner?.unresolved };
      }
      case "retire": {
        const { face, unresolved } = roleFace(ch.handle);
        return { ...base, tag: CHANGE_KIND_WORD.retire, node: face, parent: null, unresolved };
      }
      case "adopt": {
        const { face: role, unresolved } = roleFace(ch.handle);
        const stub = plan?.stubs[`session:${c._id}`];
        const offered = plan?.merged.roles.find((r) => r._id === role.id)?.sessions.find((s) => s._id === c._id);
        const node: ProposalTreeFace = { kind: "session", id: c._id, name: offered?.title ?? (stub?.this_session ? "This session" : "Offered session"), short_id: ch.conversation, stub };
        return { ...base, tag: CHANGE_KIND_WORD.adopt, node, parent: role, unresolved };
      }
      default: {
        // A chip kind: on the handle's role when it names one, else on the
        // viewer's own card, the way the chart places it.
        const handle = "handle" in ch && typeof (ch as any).handle === "string" ? (ch as any).handle as string : null;
        const owner = !handle && "owner" in ch && typeof (ch as any).owner === "string" ? ownerFace((ch as any).owner) : null;
        const subject = handle ? roleFace(handle) : owner ?? { face: meFace(), unresolved: false };
        const node = subject.face.kind === "unknown" && !subject.unresolved ? meFace() : subject.face;
        return { ...base, tag: CHANGE_KIND_WORD[ch.kind] ?? String(ch.kind), node, parent: null, chip: chipOf(c._id), unresolved: subject.unresolved };
      }
    }
  });
}

/** The changes a person never sees drawn (S23.2), as plain sentences naming
 *  the role the way the tree does, for a card that holds nothing else. */
export function proposalQuietLines(tree: OrgTree | null, changes: readonly OrgProposalChange[]): { change_id: string; status: OrgChangeStatus; line: string }[] {
  return [...changes]
    .filter((c) => c.status !== "removed" && isOrgQuietChange(c.change))
    .sort((a, b) => a.seq - b.seq)
    .map((c) => {
      const ch = editedOrgChange(c.change, c.edits);
      const handle = "handle" in ch && typeof (ch as { handle?: unknown }).handle === "string" ? (ch as { handle: string }).handle : null;
      const role = handle ? tree?.roles.find((r) => r.status !== "retired" && strip(r.handle) === strip(handle)) : undefined;
      return { change_id: c._id, status: c.status, line: quietChangeSentence(ch, role?.name) };
    });
}

/** The card's one-line outcome, once nothing waits: "3 applied", "2 applied,
 *  1 skipped", "1 failed". Null while a change is still to decide. */
export function proposalOutcome(changes: readonly OrgProposalChange[]): string | null {
  const live = changes.filter((c) => c.status !== "removed");
  if (live.length === 0 || live.some((c) => c.status === "proposed" || c.status === "failed")) return null;
  const n = (s: OrgChangeStatus) => live.filter((c) => c.status === s).length;
  const parts = [[n("applied"), "applied"], [n("accepted"), "accepted"], [n("skipped"), "skipped"]] as const;
  return parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(", ");
}
