// Waits on you (docs/architecture/org-staffing.md, essence spec 6): the one
// signal the Org screen shows. Exactly two kinds of row, both live:
//
//   decision   an open item in the viewer's decision queue that came from an
//              org conversation (a role's thread, or a session under a role)
//   proposals  open proposals with something left to decide, one row per
//              proposer, in the viewer's active workspace
//
// Nothing else adds a row: no persisted health snapshot, no blocked pin, no
// limit. A row clears by doing its action, so there is no dismiss. The rail's
// count, the list above the canvas and a role card's "Waiting on you" all
// read this one function, so the three cannot disagree. Pure; the hook in
// useNeedsYou.ts feeds it from the store.
import type { QueueItem } from "../../lib/decisionQueue";
import type { OrgRole, OrgTree } from "./orgTypes";
import type { OrgProposalAuthor, OrgProposalRow } from "./orgStaffingTypes";
import { proposalProgress, proposalRefInContext, workspaceOpenProposals, type OrgWorkspaceRef } from "./staffingModel";

/** What a row opens in the Org panel: the asking conversation, or the
 *  proposal. A subset of panelTarget's PanelRef, so it passes to open(). */
export type WaitTarget = { kind: "session"; id: string } | { kind: "proposal"; id: string };

/** A face to draw: a role's avatar by handle, or none (a person or a bare
 *  session posted it). */
export type WaitFace = { avatar?: string | null; handle: string; name?: string } | null;

export type WaitItem = {
  key: string;
  kind: "decision" | "proposals";
  /** The role the row comes from: its card reads "Waiting on you". Null when
   *  no role stands behind it (a person or an unfiled session proposed). */
  roleId: string | null;
  who: { name: string; face: WaitFace };
  /** "asks", "proposes", "proposes 3 changes". */
  verb: string;
  /** The question, or the oldest proposal's title ("…, and 2 more"). */
  words: string;
  /** Proposals in a proposer's row; 1 for a decision. */
  count: number;
  /** When it started waiting: the oldest of what the row holds. */
  at: number;
  target: WaitTarget;
  /** A single-choice `cast decide` with a few options answers right in the
   *  row; anything else opens its conversation. */
  answer?: { decisionId: string; options: string[] };
};

/** The largest option set the row answers in place; more opens the card. */
const IN_PLACE_OPTIONS = 4;

/** Every conversation the org owns, to the role that owns it: each live
 *  role's standing session and the sessions filed under it. */
export function orgConversationOwners(tree: OrgTree | null): Map<string, OrgRole> {
  const out = new Map<string, OrgRole>();
  for (const r of tree?.roles ?? []) {
    if (r.status === "retired") continue;
    if (r.standing?.conversation_id) out.set(r.standing.conversation_id, r);
    for (const s of r.sessions) out.set(s._id, r);
  }
  return out;
}

/** The queue items an org conversation asked the viewer, oldest first, each
 *  with its role. A row a role holds under a grant is the role's to clear. */
export function orgDecisions(tree: OrgTree | null, queue: readonly QueueItem[]): { item: QueueItem; role: OrgRole }[] {
  const owners = orgConversationOwners(tree);
  const out: { item: QueueItem; role: OrgRole }[] = [];
  for (const item of [...queue].sort((a, b) => a.createdAt - b.createdAt)) {
    if (item.heldByRole) continue;
    const role = owners.get(item.conversationId);
    if (role) out.push({ item, role });
  }
  return out;
}

export function canAnswerInPlace(item: QueueItem): boolean {
  const single = !item.kind || item.kind === "single";
  return item.source === "decide" && single && !!item.decisionId && item.options.length > 0 && item.options.length <= IN_PLACE_OPTIONS;
}

const faceOf = (r: Pick<OrgRole, "avatar" | "handle" | "name">): WaitFace => ({ avatar: r.avatar ?? null, handle: r.handle, name: r.name });

/** Who proposed, as one proposer: the role behind the author (a role, or the
 *  role a proposing session is filed under), else the author itself. */
function proposerOf(author: OrgProposalAuthor, tree: OrgTree | null, owners: Map<string, OrgRole>): { key: string; role: OrgRole | null; name: string; face: WaitFace } {
  const live = tree?.roles.filter((r) => r.status !== "retired") ?? [];
  const role =
    author.kind === "role" ? live.find((r) => r._id === author.id || (!!author.short_id && r.short_id === author.short_id) || (!!author.handle && r.handle === author.handle)) ?? null
    : author.kind === "session" ? owners.get(author.id) ?? null
    : null;
  if (role) return { key: `role:${role._id}`, role, name: role.name, face: faceOf(role) };
  if (author.kind === "role") return { key: `role:${author.id}`, role: null, name: author.name ?? (author.handle ? `@${author.handle}` : "A role"), face: author.handle ? { avatar: author.avatar ?? null, handle: author.handle, name: author.name } : null };
  if (author.kind === "session") return { key: `session:${author.id}`, role: null, name: author.title ?? author.name ?? "A session", face: null };
  return { key: `user:${author.id}`, role: null, name: author.name ?? "Someone", face: null };
}

export type WaitsInput = {
  tree: OrgTree | null;
  queue: readonly QueueItem[];
  /** Proposal rows, joined with whatever change rows the store holds. */
  proposals: readonly OrgProposalRow[];
  /** The viewer's active workspace: only its proposals are theirs to decide. */
  workspace: OrgWorkspaceRef | null;
};

export function waitsOnYou({ tree, queue, proposals, workspace }: WaitsInput): WaitItem[] {
  const owners = orgConversationOwners(tree);
  const open = workspaceOpenProposals(proposals, workspace).filter((p) => proposalProgress(p).remaining > 0);
  const openRefs = new Set(open.map((p) => p.short_id.toLowerCase()));

  const decisions: WaitItem[] = [];
  for (const { item, role } of orgDecisions(tree, queue)) {
    // A decision that only points at an open proposal is that proposal's row.
    const about = proposalRefInContext(item.contextMd);
    if (about && openRefs.has(about)) continue;
    decisions.push({
      key: item.key,
      kind: "decision",
      roleId: role._id,
      who: { name: role.name, face: faceOf(role) },
      verb: "asks",
      words: item.question.trim() || "A question in its thread",
      count: 1,
      at: item.createdAt,
      target: { kind: "session", id: item.conversationId },
      ...(canAnswerInPlace(item) ? { answer: { decisionId: item.decisionId!, options: item.options.map((o) => o.label) } } : {}),
    });
  }

  const byProposer = new Map<string, { proposer: ReturnType<typeof proposerOf>; rows: OrgProposalRow[] }>();
  for (const p of open) {
    const proposer = proposerOf(p.author, tree, owners);
    const group = byProposer.get(proposer.key) ?? { proposer, rows: [] };
    group.rows.push(p);
    byProposer.set(proposer.key, group);
  }
  const proposalRows: WaitItem[] = [...byProposer.values()].map(({ proposer, rows }) => {
    const sorted = [...rows].sort((a, b) => a.created_at - b.created_at);
    const oldest = sorted[0];
    const count = sorted.length;
    return {
      key: `proposals:${proposer.key}`,
      kind: "proposals",
      roleId: proposer.role?._id ?? null,
      who: { name: proposer.name, face: proposer.face },
      verb: count === 1 ? "proposes" : `proposes ${count} changes`,
      words: count === 1 ? oldest.title : `${oldest.title}, and ${count - 1} more`,
      count,
      at: oldest.created_at,
      target: { kind: "proposal", id: oldest.short_id },
    };
  });

  return [...decisions, ...proposalRows.sort((a, b) => a.at - b.at)];
}

/** The roles whose card reads "Waiting on you": exactly those with a row. */
export function waitingRoleIds(items: readonly WaitItem[]): Set<string> {
  return new Set(items.map((i) => i.roleId).filter((id): id is string => !!id));
}

// Wake signatures (store/wakeSig.ts) of the fields waitsOnYou reads, so the
// always-mounted rail count does not re-render on a tree push or heartbeat.
export function waitsTreeSig(tree: OrgTree | null): string {
  if (!tree) return "";
  return `${tree.workspace.kind}:${tree.workspace.id}|${tree.roles.map((r) => `${r._id}:${r.short_id}:${r.status}:${r.name}:${r.handle}:${r.avatar ?? ""}:${r.standing?.conversation_id ?? ""}:${r.sessions.map((s) => s._id).join(",")}`).join(";")}`;
}

export function waitsProposalsSig(rows: Record<string, Pick<OrgProposalRow, "_id" | "status" | "team_id" | "title" | "counts">> | undefined): string {
  return Object.values(rows ?? {})
    .filter((p) => p.status === "open")
    .map((p) => `${p._id}:${p.team_id ?? ""}:${p.title}:${p.counts ? `${p.counts.total}/${p.counts.decided}/${p.counts.failed}` : ""}`)
    .sort()
    .join(";");
}
