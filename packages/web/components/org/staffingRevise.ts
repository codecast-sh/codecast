// The conversation is part of the proposal (docs/architecture/org-staffing.md
// S18): the pane reads the author's thread off the proposal, and reads what
// the author's revise did to each change so the list shows it under the
// reader. Pure helpers; the pane and ProposalThread render what they return.
import { changeFields } from "./staffingModel";
import type { OrgRole, OrgTree } from "./orgTypes";
import type { OrgChangeRevision, OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";

export type ProposalThreadRef = {
  conversationId: string;
  shortId?: string;
  /** Who answers there: the role's name, or the session's title. */
  name: string;
  /** The role behind the thread, when a role wrote the proposal (its paused
   *  state is said above the composer). */
  role: OrgRole | null;
};

/**
 * The thread bound to a proposal: the server's pointer when it carries one
 * (`thread`), else derived from the author (a session author's id is its
 * conversation; a role author answers from its standing session). Null when
 * a person posted the proposal: there is no agent to talk to about it.
 */
export function proposalThread(p: Pick<OrgProposalRow, "author" | "thread">, tree: OrgTree | null): ProposalThreadRef | null {
  if (p.thread === null) return null;
  const role = p.author.kind === "role" ? tree?.roles.find((r) => r._id === p.author.id) ?? null : null;
  const name = role?.name ?? p.author.name ?? p.author.title ?? (p.author.kind === "role" ? "the agent that wrote this" : "the session that wrote this");
  if (p.thread?.conversation_id) return { conversationId: p.thread.conversation_id, shortId: p.thread.short_id, name, role };
  if (p.author.kind === "session") return { conversationId: p.author.id, shortId: p.author.short_id, name, role };
  if (role?.standing?.conversation_id) return { conversationId: role.standing.conversation_id, shortId: role.standing.short_id, name, role };
  return null;
}

/** One field the amend moved: its label, what it was, what it is now. */
export type FieldMove = { key: string; label: string; from: string | null; to: string | null };

/** What an amend changed, field by field, from `revision.before` to the
 *  change as it reads now. Empty when the row carries no before (a removed
 *  or added row), or when nothing readable moved (a rationale-only amend). */
export function amendedMoves(c: Pick<OrgProposalChange, "change" | "revision">): FieldMove[] {
  const before = c.revision?.kind === "amended" ? c.revision.before : undefined;
  if (!before) return [];
  const was = new Map(changeFields(before).map((f) => [f.key, f]));
  const now = new Map(changeFields(c.change).map((f) => [f.key, f]));
  const out: FieldMove[] = [];
  for (const [key, f] of now) {
    const w = was.get(key);
    if (!w) out.push({ key, label: f.label, from: null, to: f.value });
    else if (w.value !== f.value) out.push({ key, label: f.label, from: w.value, to: f.value });
  }
  for (const [key, w] of was) if (!now.has(key)) out.push({ key, label: w.label, from: w.value, to: null });
  return out;
}

/** The revise, in the reader's words: what happened and what the author said. */
export function revisionWord(r: OrgChangeRevision): string {
  return r.kind === "removed" ? "Removed" : r.kind === "amended" ? "Changed" : "New";
}

/** Changes the author revised after `since`: what landed under the reader
 *  since they last looked, newest first. */
export function revisedSince(changes: OrgProposalChange[], since: number): OrgProposalChange[] {
  return changes.filter((c) => c.revision && c.revision.at > since).sort((a, b) => b.revision!.at - a.revision!.at);
}

/** The latest revise on the proposal, or 0. A watermark reads this once on
 *  open so a reload does not announce old revises as new. */
export function latestRevisionAt(changes: OrgProposalChange[]): number {
  let at = 0;
  for (const c of changes) if (c.revision && c.revision.at > at) at = c.revision.at;
  return at;
}

/** "The agent removed 1 change, changed 2 and added 1 since you last looked." */
export function revisedLine(rows: OrgProposalChange[], who: string): string {
  const n = { removed: 0, amended: 0, added: 0 };
  for (const r of rows) if (r.revision) n[r.revision.kind] += 1;
  const parts: string[] = [];
  if (n.removed) parts.push(`removed ${n.removed}`);
  if (n.amended) parts.push(`changed ${n.amended}`);
  if (n.added) parts.push(`added ${n.added}`);
  if (parts.length === 0) return "";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${who} ${list} since you last looked.`;
}
