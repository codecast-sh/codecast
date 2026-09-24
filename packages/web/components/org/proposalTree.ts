// The small tree a proposal card draws (docs/architecture/org-staffing.md
// S24): each change as one row, "who reports to whom after the change" in the
// chart's own terms. Pure: the rows come from the SAME merge the chart draws
// its ghosts from (ghostsFor), so a card in a conversation and the org page
// never disagree about what a proposal changes. Without a tree (the org
// feeder has not answered, or the proposal belongs to another workspace) the
// rows keep their lines and statuses and lose their faces.
import { describeOrgChange, editedOrgChange, isOrgQuietChange, quietChangeSentence, type OrgChangeKind, type OrgChangeStatus } from "@codecast/shared/contracts/orgProposal";
import type { OrgParentRef, OrgTree } from "./orgTypes";
import type { OrgProposalChange } from "./orgStaffingTypes";
import { ghostsFor, roleNodeId, type OrgGhostOptions, type OrgGhostPlan, type OrgGhostStub } from "./orgLayout";
import { CHANGE_KIND_WORD } from "./orgMeta";

/** One face on a row: a person, a role (live or a stub), an offered session,
 *  or a handle nothing in the workspace answers to. */
export type ProposalTreeFace =
  | { kind: "person"; id: string; name: string; image?: string; me: boolean }
  | { kind: "role"; id: string; name: string; handle: string; avatar?: string; stub?: OrgGhostStub }
  | { kind: "session"; id: string; name: string; short_id: string; stub?: OrgGhostStub }
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
  /** A move: who the node reported to before, drawn faded. */
  from: ProposalTreeFace | null;
  /** A change that is neither a node nor an edge (scope, limit, routine, a
   *  record's status): the delta alone, read on the node. */
  chip: string | null;
  /** The subject's handle answers to nothing live: drawn as a warning. */
  unresolved: boolean;
};

const strip = (h: string) => h.replace(/^@/, "").trim().toLowerCase();

const faceOfRef = (plan: OrgGhostPlan, ref: OrgParentRef | null | undefined): ProposalTreeFace | null => {
  if (!ref) return null;
  if (ref.kind === "user") {
    const p = plan.merged.people.find((x) => x.user_id === ref.user_id);
    return p ? { kind: "person", id: p.user_id, name: p.name, image: p.image, me: p.is_me } : { kind: "unknown", id: ref.user_id, name: "a person" };
  }
  const r = plan.merged.roles.find((x) => x._id === ref.role_id);
  return r
    ? { kind: "role", id: r._id, name: r.name, handle: r.handle, avatar: r.avatar, stub: plan.stubs[roleNodeId(r._id)] }
    : { kind: "unknown", id: ref.role_id, name: "a role" };
};

/** The rows of a proposal, in seq order. Removed changes are history and
 *  draw nothing; skipped ones keep a row so the card can say what happened;
 *  a quiet kind (a limit, S23.2) never draws a row (proposalQuietLines). */
export function proposalTreeRows(tree: OrgTree | null, changes: readonly OrgProposalChange[], opts: OrgGhostOptions = {}): ProposalTreeRow[] {
  const ordered = [...changes].filter((c) => c.status !== "removed" && !isOrgQuietChange(c.change)).sort((a, b) => a.seq - b.seq);
  const plan = tree ? ghostsFor(tree, changes, opts) : null;
  const liveRole = (handle: string) => plan?.merged.roles.find((r) => r.status !== "retired" && strip(r.handle) === strip(handle));
  const me = plan?.merged.people.find((p) => p.is_me) ?? plan?.merged.people[0];
  const meFace = (): ProposalTreeFace => (me ? { kind: "person", id: me.user_id, name: me.name, image: me.image, me: me.is_me } : { kind: "unknown", id: "me", name: "you" });
  const roleFace = (handle: string, name?: string): { face: ProposalTreeFace; unresolved: boolean } => {
    const r = liveRole(handle);
    if (r && plan) return { face: { kind: "role", id: r._id, name: r.name, handle: r.handle, avatar: r.avatar, stub: plan.stubs[roleNodeId(r._id)] }, unresolved: false };
    return { face: { kind: "unknown", id: strip(handle), name: name ?? `@${strip(handle)}` }, unresolved: !!plan };
  };
  const chipOf = (changeId: string): string | null => {
    if (!plan) return null;
    for (const chips of Object.values(plan.chips)) for (const c of chips) if (c.change_id === changeId) return c.chip;
    return null;
  };

  return ordered.map((c): ProposalTreeRow => {
    const ch = editedOrgChange(c.change, c.edits);
    const base = { change_id: c._id, seq: c.seq, kind: ch.kind, status: c.status, line: describeOrgChange(ch), from: null, chip: null, unresolved: false } as const;
    switch (ch.kind) {
      case "role": {
        // The stub ghostsFor pushed (keyed by the change id), else the live
        // role the tree already carries (the proposal was superseded by it).
        const stub = plan?.merged.roles.find((r) => r._id === c._id) ?? liveRole(ch.handle);
        const node: ProposalTreeFace = stub && plan
          ? { kind: "role", id: stub._id, name: stub.name, handle: stub.handle, avatar: stub.avatar, stub: plan.stubs[roleNodeId(stub._id)] }
          : { kind: "role", id: c._id, name: ch.name, handle: strip(ch.handle), avatar: ch.avatar };
        return { ...base, tag: "new role", node, parent: stub && plan ? faceOfRef(plan, stub.reports_to) : null };
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
        const handle = "handle" in ch && typeof (ch as any).handle === "string" ? (ch as any).handle as string : "owner" in ch && typeof (ch as any).owner === "string" ? (ch as any).owner as string : null;
        const subject = handle ? roleFace(handle) : { face: meFace(), unresolved: false };
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
